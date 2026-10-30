import { isRateLimited, NotesApiError } from './errors';
import { parseApiPath, pathInsideSyncFolder, toApiPath } from './paths';

/** One-by-one deletes from a sync tool still land in a single prompt. */
export const SITE_DELETE_DEBOUNCE_MS = 750;

export type SiteDeleteSetting = 'ask' | 'always' | 'never';

export function siteDeleteSetting(value: unknown): SiteDeleteSetting {
	return value === 'always' || value === 'never' ? value : 'ask';
}

export type RenamePlan =
	| { kind: 'ignore' }
	| { kind: 'move-on-site'; fromApiPath: string; toApiPath: string }
	| { kind: 'left-folder'; fromApiPath: string }
	| { kind: 'entered-folder'; toApiPath: string };

/**
 * A vault rename has already happened. This only decides what the site should do.
 * Conflict copies are ignored. A move that stays outside the sync folder is ignored.
 */
export function planVaultRename(syncFolder: string, oldPath: string, newPath: string): RenamePlan {
	if (!oldPath.endsWith('.md') || !newPath.endsWith('.md')) return { kind: 'ignore' };
	if (oldPath.includes(' (site conflict') || newPath.includes(' (site conflict')) {
		return { kind: 'ignore' };
	}
	const oldInside = pathInsideSyncFolder(syncFolder, oldPath);
	const nextInside = pathInsideSyncFolder(syncFolder, newPath);
	if (oldInside && nextInside) {
		const from = toApiPath(syncFolder, oldPath);
		const to = toApiPath(syncFolder, newPath);
		if (!from.ok || !to.ok) return { kind: 'ignore' };
		if (from.apiPath === to.apiPath) return { kind: 'ignore' };
		return { kind: 'move-on-site', fromApiPath: from.apiPath, toApiPath: to.apiPath };
	}
	if (oldInside && !nextInside) {
		const from = toApiPath(syncFolder, oldPath);
		if (!from.ok) return { kind: 'ignore' };
		return { kind: 'left-folder', fromApiPath: from.apiPath };
	}
	if (!oldInside && nextInside) {
		const to = toApiPath(syncFolder, newPath);
		if (!to.ok) return { kind: 'ignore' };
		return { kind: 'entered-folder', toApiPath: to.apiPath };
	}
	return { kind: 'ignore' };
}

export type DeleteChoice = 'ask' | 'delete' | 'keep';

/** Only a note we have published is worth a site delete. The file is already gone locally. */
export function planVaultDelete(
	syncFolder: string,
	vaultPath: string,
	wasSynced: boolean,
	setting: SiteDeleteSetting,
): DeleteChoice {
	if (!wasSynced || !vaultPath.endsWith('.md')) return 'keep';
	if (!pathInsideSyncFolder(syncFolder, vaultPath)) return 'keep';
	if (!toApiPath(syncFolder, vaultPath).ok) return 'keep';
	if (setting === 'always') return 'delete';
	if (setting === 'never') return 'keep';
	return 'ask';
}

export const DELETE_ON_SITE = 'Delete on site too';
export const KEEP_ON_SITE = 'Keep on site';

export function siteDeletePrompt(apiPath: string): string {
	return `"${apiPath}" was removed from the vault. Delete it on the site too? It goes to the trash and can be restored.`;
}

export function leftFolderPrompt(apiPath: string): string {
	return `"${apiPath}" left the sync folder. Delete it on the site too? It goes to the trash and can be restored.`;
}

export function bulkDeletePrompt(count: number): string {
	return `Delete ${count} notes on the site? They go to the trash and can be restored.`;
}

/**
 * One deleted note honors the setting. Moving a note out of the sync folder
 * never uses Always. A batch always asks, including a folder delete or a
 * burst from a sync tool.
 */
export function planDeleteBatch(input: {
	count: number;
	setting: SiteDeleteSetting;
	leftFolder: boolean;
}): DeleteChoice {
	if (input.count > 1) return 'ask';
	if (input.leftFolder && input.setting !== 'never') return 'ask';
	if (input.setting === 'always') return 'delete';
	if (input.setting === 'never') return 'keep';
	return 'ask';
}

/**
 * Restore must not replace a vault file that has changed since the last sync.
 * No local file, or a file that still matches the remembered fingerprint, can
 * take the restored text. Anything else stays put.
 */
export function planRestore(input: {
	localExists: boolean;
	localFingerprint?: string;
	syncedFingerprint?: string;
}): 'write-restored' | 'keep-local' {
	if (!input.localExists) return 'write-restored';
	if (!input.localFingerprint || !input.syncedFingerprint) return 'keep-local';
	if (input.localFingerprint !== input.syncedFingerprint) return 'keep-local';
	return 'write-restored';
}

export interface SiteDeleteItem {
	apiPath: string;
	revision: string;
	kind: 'deleted' | 'left-folder';
}

/** Restarts the wait on every push, so a burst stays one batch. */
export function createRestartingBatcher<T>(
	waitMs: number,
	setTimer: (callback: () => void, ms: number) => () => void,
	onFlush: (items: T[]) => void,
): { push(item: T): void; cancel(): void } {
	let queue: T[] = [];
	let cancelTimer: (() => void) | null = null;
	return {
		push(item) {
			queue.push(item);
			cancelTimer?.();
			cancelTimer = setTimer(() => {
				cancelTimer = null;
				const batch = queue;
				queue = [];
				onFlush(batch);
			}, waitMs);
		},
		cancel() {
			cancelTimer?.();
			cancelTimer = null;
		},
	};
}

export interface TrashRun {
	trashed: string[];
	failed: { apiPath: string; message: string }[];
	notFinished: string[];
	rateLimited: boolean;
}

export function summarizeTrashRun(result: TrashRun): string {
	const total = result.trashed.length + result.failed.length + result.notFinished.length;
	if (total === 1 && result.trashed.length === 1) {
		return `Moved ${result.trashed[0]} to the site trash. It can be restored.`;
	}
	const parts = [`Trashed ${result.trashed.length} of ${total}.`];
	if (result.rateLimited) parts.push('Stopped because the site is rate limiting.');
	const left = [
		...result.failed.map((item) => `${item.apiPath} (${item.message})`),
		...result.notFinished,
	];
	if (left.length > 0) parts.push(`Left: ${left.join(', ')}.`);
	if (result.trashed.length > 0) parts.push('Trashed notes can be restored.');
	return parts.join(' ');
}

export function summarizeMoveRun(input: {
	moved: number;
	total: number;
	failed: { apiPath: string; message: string }[];
	notFinished: string[];
	rateLimited: boolean;
}): string {
	const parts = [`Moved ${input.moved} of ${input.total} notes on the site.`];
	if (input.rateLimited) parts.push('Stopped because the site is rate limiting.');
	if (input.failed.length > 0) {
		const details = input.failed.map((item) => `${item.apiPath} (${item.message})`).join('; ');
		parts.push(`Failed: ${details}.`);
	}
	if (input.notFinished.length > 0) parts.push(`Not finished: ${input.notFinished.join(', ')}.`);
	return parts.join(' ');
}

/** A move that missed because another device already renamed the note. */
export function shouldAdoptMove(error: NotesApiError): boolean {
	return (
		error.status === 404 ||
		error.code === 'not_found' ||
		error.code === 'path_exists' ||
		error.code === 'slug_exists'
	);
}

export function probeSaysTrashed(error: unknown): boolean {
	return (
		error instanceof NotesApiError &&
		(error.code === 'gone' || error.code === 'deleted' || error.status === 410)
	);
}

export function probeSaysMissing(error: unknown): boolean {
	return error instanceof NotesApiError && (error.code === 'not_found' || error.status === 404);
}

export function isRateLimitFailure(error: unknown): boolean {
	return isRateLimited(error);
}

export async function runUntilRateLimit<T>(
	items: readonly T[],
	step: (item: T) => Promise<'ok' | { rateLimited: string } | { failed: string }>,
	options?: { stopOnAnyFailure?: boolean },
): Promise<{
	succeeded: number;
	failed: { item: T; message: string }[];
	notFinished: T[];
	rateLimited: boolean;
}> {
	const failed: { item: T; message: string }[] = [];
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item) continue;
		const result = await step(item);
		if (result === 'ok') continue;
		if ('rateLimited' in result) {
			return {
				succeeded: index - failed.length,
				failed,
				notFinished: items.slice(index),
				rateLimited: true,
			};
		}
		failed.push({ item, message: result.failed });
		if (options?.stopOnAnyFailure) {
			return {
				succeeded: index - failed.length + 1,
				failed,
				notFinished: items.slice(index + 1),
				rateLimited: false,
			};
		}
	}
	return {
		succeeded: items.length - failed.length,
		failed,
		notFinished: [],
		rateLimited: false,
	};
}

/** Where a delete should go after the site says the note moved. */
export function deleteTargetAfterMove(
	error: NotesApiError,
	fallbackRevision: string,
): { apiPath: string; revision: string } | null {
	if (error.code !== 'moved' || !error.location) return null;
	const apiPath = canonicalApiPath(error.location);
	if (!apiPath) return null;
	return { apiPath, revision: error.note?.revision ?? fallbackRevision };
}

export async function performRestore(input: {
	label: string;
	vaultPath: string;
	restoredContent: string;
	restoredRevision: string;
	localContent: string | null;
	syncedFingerprint?: string;
	fingerprint: (text: string) => string;
	preserve: (local: string, incoming: string) => string;
	conflictPath: string;
	write: (path: string, content: string) => Promise<void>;
	publishLocal: (
		content: string,
		revision: string,
	) => Promise<{ ok: true; revision: string; fingerprint: string } | { ok: false; message: string }>;
}): Promise<{
	notice: string;
	synced: { revision: string; fingerprint: string };
	conflictRevision?: string;
	wroteOriginal: boolean;
}> {
	const plan = planRestore({
		localExists: input.localContent !== null,
		localFingerprint: input.localContent !== null ? input.fingerprint(input.localContent) : undefined,
		syncedFingerprint: input.syncedFingerprint,
	});
	if (plan === 'write-restored') {
		const content =
			input.localContent !== null
				? input.preserve(input.localContent, input.restoredContent)
				: input.restoredContent;
		await input.write(input.vaultPath, content);
		return {
			wroteOriginal: true,
			synced: { revision: input.restoredRevision, fingerprint: input.fingerprint(content) },
			notice: `Restored ${input.label} from the site trash.`,
		};
	}
	await input.write(input.conflictPath, input.restoredContent);
	const published = await input.publishLocal(input.localContent ?? '', input.restoredRevision);
	if (published.ok) {
		return {
			wroteOriginal: false,
			synced: { revision: published.revision, fingerprint: published.fingerprint },
			notice: `Kept your edits in ${input.label}. Saved the restored copy beside the note and published your text.`,
		};
	}
	return {
		wroteOriginal: false,
		synced: {
			revision: input.restoredRevision,
			fingerprint: input.fingerprint(input.restoredContent),
		},
		conflictRevision: input.restoredRevision,
		notice: `Restored ${input.label} on the site, kept your local edits, and saved the site copy beside the note. ${published.message}`,
	};
}

export interface MoveChainState {
	apiPath: string;
	revision: string;
}

/**
 * Serializes site moves for one note. A rename that lands while the previous
 * move is still in flight queues behind it and uses the revision that move
 * returns, instead of looking up a path the site does not have yet.
 */
export function createMoveChain(): {
	has(apiPath: string): boolean;
	enqueue(
		fromApiPath: string,
		toApiPath: string,
		revisionIfIdle: string | undefined,
		move: (from: string, to: string, revision: string) => Promise<string | null>,
	): Promise<MoveChainState | null>;
} {
	const tails = new Map<string, Promise<MoveChainState | null>>();
	return {
		has(apiPath) {
			return tails.has(apiPath);
		},
		enqueue(fromApiPath, toApiPath, revisionIfIdle, move) {
			const previous = tails.get(fromApiPath) ?? Promise.resolve(null);
			const next = previous.then(async (state) => {
				const from = state?.apiPath ?? fromApiPath;
				const revision = state?.revision ?? revisionIfIdle;
				if (!revision) return state;
				try {
					const nextRevision = await move(from, toApiPath, revision);
					if (!nextRevision) return state;
					return { apiPath: toApiPath, revision: nextRevision };
				} catch {
					return state;
				}
			});
			tails.delete(fromApiPath);
			tails.set(toApiPath, next);
			void next.finally(() => {
				if (tails.get(toApiPath) === next) tails.delete(toApiPath);
			});
			return next;
		},
	};
}

export interface RemoteMove {
	fromApiPath: string;
	toApiPath: string;
	revision?: string;
}

/**
 * Synced paths that are neither live nor trashed need a GET.
 * The trash is already settled: do not download those notes again.
 */
export function planRemoteReconcile(
	knownPaths: readonly string[],
	livePaths: readonly string[],
	deletedPaths: readonly string[],
): { probe: string[]; gone: string[] } {
	const live = new Set(livePaths);
	const deleted = new Set(deletedPaths);
	const probe: string[] = [];
	const gone: string[] = [];
	for (const path of knownPaths) {
		if (deleted.has(path)) {
			gone.push(path);
			continue;
		}
		if (live.has(path)) continue;
		probe.push(path);
	}
	return { probe, gone };
}

export function canonicalApiPath(input: string): string | null {
	const parsed = parseApiPath(input);
	return parsed.ok ? parsed.apiPath : null;
}
