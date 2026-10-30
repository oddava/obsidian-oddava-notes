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
