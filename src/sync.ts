import { jsonByteLength, MAX_NOTES_API_BYTES, NotesClient } from './api';
import { isFatalApiError, NotesApiError } from './errors';
import { contentFingerprint } from './fingerprint';
import {
	isLocalNewer,
	isRemoteNewer,
	noteBodiesMatch,
	readUpdated,
} from './frontmatter';
import { explainError, conflictSavedMessage, blockedConflictMessage, slugConflictMessage } from './messages';
import {
	hasOpenConflict,
	nextConflictVaultPath,
	parseApiPath,
	vaultDirectory,
	vaultBasename,
} from './paths';
import type { NoteRecord, NoteSummary } from './types';

/**
 * Publish and pull, with no Obsidian and no HTTP of their own.
 * The caller reads and writes vault files. This module decides what to do
 * and talks to the site through `NotesClient`.
 *
 * A remembered revision lives outside the note. The site drops any frontmatter
 * key other than title, icon, order, and updated, so a revision written into
 * the file would not come back. A fingerprint of the vault text is stored
 * beside the revision so pull can tell a local edit from a site edit.
 *
 * On `revision_conflict` the 409 body has the new revision but not the
 * Markdown. This module fetches the note and asks the caller to save it
 * beside the vault note. It does not PUT again, and it does not change the
 * vault note.
 */

export interface PublishInput {
	apiPath: string;
	vaultPath: string;
	content: string;
	revision?: string;
	pendingConflictRevision?: string;
	siblingNames: readonly string[];
}

export type PublishResult =
	| {
			kind: 'published';
			created: boolean;
			adopted: boolean;
			apiPath: string;
			revision: string;
			fingerprint: string;
			message: string;
	  }
	| {
			kind: 'conflict';
			apiPath: string;
			conflictVaultPath: string;
			remote: NoteRecord;
			message: string;
	  }
	| { kind: 'blocked'; message: string }
	| { kind: 'error'; message: string };

export interface LocalNote {
	vaultPath: string;
	exists: boolean;
	content?: string;
	fingerprint?: string;
	revision?: string;
	updated?: string;
	siblingNames?: readonly string[];
}

export type PullDecision =
	| { action: 'download'; reason: 'new' | 'newer' }
	| { action: 'align' }
	| { action: 'conflict' }
	| { action: 'skip'; reason: string }
	| 'need-body';

export interface DownloadedNote {
	apiPath: string;
	vaultPath: string;
	content: string;
	revision: string;
	fingerprint: string;
	reason: 'new' | 'newer';
}

export interface AlignedNote {
	apiPath: string;
	revision: string;
	fingerprint: string;
}

export interface PullConflict {
	apiPath: string;
	conflictVaultPath: string;
	remote: NoteRecord;
	message: string;
}

export interface PullSkip {
	apiPath: string;
	reason: string;
}

export interface PullResult {
	downloaded: DownloadedNote[];
	aligned: AlignedNote[];
	conflicts: PullConflict[];
	skipped: PullSkip[];
	stoppedEarly?: string;
}

export async function publishNote(client: NotesClient, input: PublishInput): Promise<PublishResult> {
	if (hasOpenConflict(input.vaultPath, input.siblingNames)) {
		return { kind: 'blocked', message: blockedConflictMessage() };
	}

	const revision = input.pendingConflictRevision ?? input.revision;

	try {
		if (revision) {
			const updated = await putOrRecreate(client, input, revision);
			if (updated) return updated;
		}
		return await createOrAdopt(client, input);
	} catch (error) {
		return { kind: 'error', message: explainError(error) };
	}
}

export function decideWithoutBody(local: LocalNote, summary: NoteSummary): PullDecision {
	if (local.exists && hasOpenConflict(local.vaultPath, local.siblingNames ?? [])) {
		return { action: 'skip', reason: 'A conflict file is still open for this note.' };
	}
	if (!local.exists) return 'need-body';
	if (local.revision && local.revision === summary.revision) {
		if (local.content === undefined) {
			return { action: 'skip', reason: 'Could not read the vault note.' };
		}
		if (!local.fingerprint) return 'need-body';
		if (contentFingerprint(local.content) !== local.fingerprint) {
			return { action: 'skip', reason: 'The vault note has unpublished edits.' };
		}
		return { action: 'align' };
	}
	return 'need-body';
}

export function decideWithBody(local: LocalNote, note: NoteRecord): PullDecision {
	if (!local.exists) return { action: 'download', reason: 'new' };

	const content = local.content ?? '';
	if (local.revision && local.revision === note.revision) {
		if (noteBodiesMatch(content, note.content)) return { action: 'align' };
		return { action: 'skip', reason: 'The vault note has unpublished edits.' };
	}

	if (noteBodiesMatch(content, note.content)) return { action: 'align' };

	const unchanged =
		local.fingerprint !== undefined && contentFingerprint(content) === local.fingerprint;
	const dirty = local.fingerprint !== undefined && !unchanged;
	if (dirty) return { action: 'conflict' };
	if (unchanged) return { action: 'download', reason: 'newer' };

	if (isRemoteNewer(note.updated, readUpdated(content) ?? local.updated)) {
		return { action: 'download', reason: 'newer' };
	}
	if (isLocalNewer(readUpdated(content) ?? local.updated, note.updated)) {
		return { action: 'skip', reason: 'The vault copy is newer.' };
	}
	return { action: 'conflict' };
}

export async function pullFromSite(
	client: NotesClient,
	readLocal: (apiPath: string) => Promise<LocalNote> | LocalNote,
): Promise<PullResult> {
	const result: PullResult = { downloaded: [], aligned: [], conflicts: [], skipped: [] };
	let notes: NoteSummary[];
	try {
		notes = await client.list();
	} catch (error) {
		result.stoppedEarly = explainError(error);
		return result;
	}

	const reserved = new Map<string, Set<string>>();

	for (const summary of notes) {
		const parsed = parseApiPath(summary.path);
		if (!parsed.ok) {
			result.skipped.push({ apiPath: summary.path, reason: parsed.reason });
			continue;
		}
		const apiPath = parsed.apiPath;

		let local: LocalNote;
		try {
			local = await readLocal(apiPath);
		} catch (error) {
			result.skipped.push({ apiPath, reason: explainError(error) });
			continue;
		}
		local = withReservedSiblings(local, reserved);

		const early = decideWithoutBody({ ...local, revision: local.revision }, {
			...summary,
			path: apiPath,
		});
		if (early !== 'need-body') {
			applyEarly(result, apiPath, local, summary.revision, early);
			continue;
		}

		let note: NoteRecord;
		try {
			note = await client.get(apiPath);
		} catch (error) {
			if (isFatalApiError(error) || !(error instanceof NotesApiError)) {
				result.stoppedEarly = explainError(error);
				break;
			}
			result.skipped.push({ apiPath, reason: explainError(error) });
			continue;
		}

		const decision = decideWithBody(local, note);
		applyWithBody(result, apiPath, local, note, decision, reserved);
	}

	return result;
}

/** Downloads and conflict copies only. Null when the vault text did not change. */
export function summarizeChangedNotes(result: PullResult): string | null {
	const created = result.downloaded.filter((note) => note.reason === 'new').length;
	const updated = result.downloaded.filter((note) => note.reason === 'newer').length;
	const parts: string[] = [];
	if (created > 0) {
		parts.push(`Downloaded ${created} new ${created === 1 ? 'note' : 'notes'}.`);
	}
	if (updated > 0) {
		parts.push(`Updated ${updated} ${updated === 1 ? 'note' : 'notes'} from the site.`);
	}
	if (result.conflicts.length > 0) {
		const names = result.conflicts
			.slice(0, 3)
			.map((conflict) => vaultBasename(conflict.conflictVaultPath));
		const extra =
			result.conflicts.length > 3 ? `, and ${result.conflicts.length - 3} more` : '';
		const label =
			result.conflicts.length === 1 ? 'a site conflict' : `${result.conflicts.length} site conflicts`;
		parts.push(`Saved ${label} (${names.join(', ')}${extra}). Neither side was overwritten.`);
	}
	if (parts.length === 0) return null;
	return parts.join(' ');
}

export function summarizePull(result: PullResult): string {
	const parts: string[] = [];
	const changed = summarizeChangedNotes(result);
	if (changed) parts.push(changed);
	if (result.skipped.length > 0) {
		parts.push(
			`Left ${result.skipped.length} ${result.skipped.length === 1 ? 'note' : 'notes'} in the vault unchanged.`,
		);
	}
	if (result.stoppedEarly) parts.push(result.stoppedEarly);
	if (parts.length > 0) return parts.join(' ');
	if (result.aligned.length > 0) {
		return `Already up to date (${result.aligned.length} ${result.aligned.length === 1 ? 'note' : 'notes'}).`;
	}
	return 'The site has no notes yet.';
}

export async function testConnection(client: NotesClient): Promise<string> {
	const notes = await client.list();
	const noun = notes.length === 1 ? 'note' : 'notes';
	return `Connected. ${notes.length} ${noun} on the site.`;
}

async function putOrRecreate(
	client: NotesClient,
	input: PublishInput,
	revision: string,
): Promise<PublishResult | null> {
	const sizeError = payloadTooLarge({ content: input.content, revision });
	if (sizeError) return { kind: 'error', message: sizeError };
	try {
		const note = await client.update(input.apiPath, input.content, revision);
		return published(input, note, false, false);
	} catch (error) {
		if (error instanceof NotesApiError && error.status === 404) return null;
		if (error instanceof NotesApiError && error.code === 'revision_conflict') {
			const remote = await readRemote(client, input.apiPath, error.note);
			return conflictResult(input, remote);
		}
		throw error;
	}
}

async function createOrAdopt(client: NotesClient, input: PublishInput): Promise<PublishResult> {
	const sizeError = payloadTooLarge({ path: input.apiPath, content: input.content });
	if (sizeError) return { kind: 'error', message: sizeError };
	try {
		const note = await client.create(input.apiPath, input.content);
		return published(input, note, true, false);
	} catch (error) {
		if (error instanceof NotesApiError && error.code === 'path_exists') {
			const remote = await readRemote(client, input.apiPath, error.note);
			if (noteBodiesMatch(input.content, remote.content)) {
				return published(input, remote, false, true);
			}
			return conflictResult(input, remote);
		}
		if (error instanceof NotesApiError && error.code === 'slug_exists') {
			return { kind: 'error', message: slugConflictMessage(error.note?.path) };
		}
		throw error;
	}
}

async function readRemote(
	client: NotesClient,
	apiPath: string,
	summary: NoteSummary | undefined,
): Promise<NoteRecord> {
	if (summary && 'content' in summary && typeof (summary as NoteRecord).content === 'string') {
		return summary as NoteRecord;
	}
	const path = summary?.path ?? apiPath;
	return client.get(path);
}

function published(
	input: PublishInput,
	note: NoteRecord,
	created: boolean,
	adopted: boolean,
): PublishResult {
	const fingerprint = contentFingerprint(input.content);
	let message: string;
	if (adopted) {
		message = `The site already had ${input.apiPath} with the same text. Remembered its revision.`;
	} else if (created) {
		message = `Created ${input.apiPath} on the site.`;
	} else {
		message = `Published ${input.apiPath}.`;
	}
	return {
		kind: 'published',
		created,
		adopted,
		apiPath: input.apiPath,
		revision: note.revision,
		fingerprint,
		message,
	};
}

function conflictResult(input: PublishInput, remote: NoteRecord): PublishResult {
	const conflictVaultPath = nextConflictVaultPath(input.vaultPath, input.siblingNames);
	return {
		kind: 'conflict',
		apiPath: input.apiPath,
		conflictVaultPath,
		remote,
		message: conflictSavedMessage(conflictVaultPath),
	};
}

function payloadTooLarge(payload: unknown): string | null {
	if (jsonByteLength(payload) > MAX_NOTES_API_BYTES) {
		return 'This note is larger than 1 MB, which the site does not accept.';
	}
	return null;
}

function applyEarly(
	result: PullResult,
	apiPath: string,
	local: LocalNote,
	revision: string,
	decision: Exclude<PullDecision, 'need-body'>,
): void {
	if (decision.action === 'align') {
		result.aligned.push({
			apiPath,
			revision,
			fingerprint: contentFingerprint(local.content ?? ''),
		});
		return;
	}
	if (decision.action === 'skip') {
		result.skipped.push({ apiPath, reason: decision.reason });
		return;
	}
	// A download still needs the body. Callers only pass align or skip here.
	result.skipped.push({ apiPath, reason: 'The note could not be downloaded.' });
}

function applyWithBody(
	result: PullResult,
	apiPath: string,
	local: LocalNote,
	note: NoteRecord,
	decision: PullDecision,
	reserved: Map<string, Set<string>>,
): void {
	if (decision === 'need-body') {
		result.skipped.push({ apiPath, reason: 'The note could not be compared.' });
		return;
	}
	if (decision.action === 'align') {
		result.aligned.push({
			apiPath,
			revision: note.revision,
			fingerprint: contentFingerprint(local.content ?? ''),
		});
		return;
	}
	if (decision.action === 'skip') {
		result.skipped.push({ apiPath, reason: decision.reason });
		return;
	}
	if (decision.action === 'download') {
		result.downloaded.push({
			apiPath,
			vaultPath: local.vaultPath,
			content: note.content,
			revision: note.revision,
			fingerprint: contentFingerprint(note.content),
			reason: decision.reason,
		});
		reserve(reserved, local.vaultPath);
		return;
	}
	const siblings = local.siblingNames ?? [];
	const conflictVaultPath = nextConflictVaultPath(local.vaultPath, siblings);
	result.conflicts.push({
		apiPath,
		conflictVaultPath,
		remote: note,
		message: conflictSavedMessage(conflictVaultPath),
	});
	reserve(reserved, conflictVaultPath);
}

function withReservedSiblings(local: LocalNote, reserved: Map<string, Set<string>>): LocalNote {
	const extra = reserved.get(vaultDirectory(local.vaultPath));
	if (!extra || extra.size === 0) return local;
	return {
		...local,
		siblingNames: [...(local.siblingNames ?? []), ...extra],
	};
}

function reserve(reserved: Map<string, Set<string>>, vaultPath: string): void {
	const directory = vaultDirectory(vaultPath);
	const names = reserved.get(directory) ?? new Set<string>();
	names.add(vaultBasename(vaultPath));
	reserved.set(directory, names);
}
