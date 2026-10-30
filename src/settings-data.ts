import { DEFAULT_TELEGRAM_CHANNEL, normalizeTelegramChannel } from './telegram';

/** Floor so a pull cannot loop inside the site's 120 requests/minute limit. */
export const MIN_AUTO_PULL_MINUTES = 1;

export const DEFAULT_AUTO_PULL_MINUTES = 5;

export function clampAutoPullMinutes(value: unknown): number {
	const numeric =
		typeof value === 'number'
			? value
			: typeof value === 'string' && value.trim()
				? Number(value.trim())
				: Number.NaN;
	if (!Number.isFinite(numeric)) return DEFAULT_AUTO_PULL_MINUTES;
	return Math.max(MIN_AUTO_PULL_MINUTES, Math.round(numeric));
}

export interface SyncedNote {
	revision: string;
	fingerprint: string;
}

export interface OddavaSettings {
	baseUrl: string;
	apiToken: string;
	syncFolder: string;
	publishOnSave: boolean;
	/** Pull while Obsidian is open. On unless the saved settings turn it off. */
	autoPull: boolean;
	/** Minutes between automatic pulls. Clamped to at least one minute. */
	autoPullIntervalMinutes: number;
	synced: Record<string, SyncedNote>;
	/** Site revision captured when a conflict file was written for this API path. */
	conflictRevisions: Record<string, string>;
	/** Bot token from BotFather. Empty until the user pastes one. */
	telegramBotToken: string;
	/** Channel username or numeric id. Posts remember their id in the note. */
	telegramChannel: string;
}

export function defaultSettings(): OddavaSettings {
	return {
		baseUrl: 'https://oddava.me',
		apiToken: '',
		syncFolder: 'oddava.me',
		publishOnSave: false,
		autoPull: true,
		autoPullIntervalMinutes: DEFAULT_AUTO_PULL_MINUTES,
		synced: {},
		conflictRevisions: {},
		telegramBotToken: '',
		telegramChannel: DEFAULT_TELEGRAM_CHANNEL,
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
		autoPull: typeof stored.autoPull === 'boolean' ? stored.autoPull : defaults.autoPull,
		autoPullIntervalMinutes: clampAutoPullMinutes(stored.autoPullIntervalMinutes),
		synced: sanitizeSynced(stored.synced),
		conflictRevisions: sanitizeStringMap(stored.conflictRevisions),
		telegramBotToken: typeof stored.telegramBotToken === 'string' ? stored.telegramBotToken : '',
		telegramChannel:
			normalizeTelegramChannel(typeof stored.telegramChannel === 'string' ? stored.telegramChannel : '') ??
			defaults.telegramChannel,
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
