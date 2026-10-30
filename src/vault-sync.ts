import { parseApiPath, pathInsideSyncFolder, toApiPath } from './paths';

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
