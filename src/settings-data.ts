export interface SyncedNote {
	revision: string;
	fingerprint: string;
}

export interface OddavaSettings {
	baseUrl: string;
	apiToken: string;
	syncFolder: string;
	publishOnSave: boolean;
	synced: Record<string, SyncedNote>;
	/** Site revision captured when a conflict file was written for this API path. */
	conflictRevisions: Record<string, string>;
}

export function defaultSettings(): OddavaSettings {
	return {
		baseUrl: 'https://oddava.me',
		apiToken: '',
		syncFolder: 'oddava.me',
		publishOnSave: false,
		synced: {},
		conflictRevisions: {},
	};
}

export function mergeSettings(stored: unknown): OddavaSettings {
	const defaults = defaultSettings();
	if (!isRecord(stored)) return defaults;
	return {
		baseUrl:
			typeof stored.baseUrl === 'string' && stored.baseUrl.trim()
				? stored.baseUrl
				: defaults.baseUrl,
		apiToken: typeof stored.apiToken === 'string' ? stored.apiToken : '',
		syncFolder:
			typeof stored.syncFolder === 'string' && stored.syncFolder.trim()
				? stored.syncFolder
				: defaults.syncFolder,
		publishOnSave: stored.publishOnSave === true,
		synced: sanitizeSynced(stored.synced),
		conflictRevisions: sanitizeStringMap(stored.conflictRevisions),
	};
}

function sanitizeSynced(value: unknown): Record<string, SyncedNote> {
	if (!isRecord(value)) return {};
	const synced: Record<string, SyncedNote> = {};
	for (const [path, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		if (typeof entry.revision !== 'string' || typeof entry.fingerprint !== 'string') continue;
		if (!entry.revision || !entry.fingerprint) continue;
		synced[path] = { revision: entry.revision, fingerprint: entry.fingerprint };
	}
	return synced;
}

function sanitizeStringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const map: Record<string, string> = {};
	for (const [path, revision] of Object.entries(value)) {
		if (typeof revision === 'string' && revision) map[path] = revision;
	}
	return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
