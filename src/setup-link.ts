import { normalizeBaseUrl } from './api';
import { folderProblem, normalizeSyncFolder } from './paths';

/** `obsidian://oddava-notes-setup` — the action passed to `registerObsidianProtocolHandler`. */
export const SETUP_ACTION = 'oddava-notes-setup';

export const DEFAULT_SETUP_URL = 'https://oddava.me';
export const DEFAULT_SETUP_FOLDER = 'oddava.me';

export const SETUP_LINK_COPIED =
	'Setup link copied. It contains your API token. Send it only to yourself, then open it on the other device.';

const PLACEHOLDER_TOKEN = 'your_notes_api_token';

export interface SetupSettings {
	baseUrl: string;
	apiToken: string;
	syncFolder: string;
}

export type SetupParse =
	| { ok: true; settings: SetupSettings }
	| { ok: false; reason: string };

/**
 * Build `obsidian://oddava-notes-setup?token=...&url=...&folder=...`.
 * `url` and `folder` are included when the current settings have them.
 * The token is required. Nothing here is written to a log.
 */
export function buildSetupLink(input: {
	apiToken: string;
	baseUrl?: string;
	syncFolder?: string;
}): SetupParse & { link?: string } {
	const parsed = parseSetupLink({
		token: input.apiToken,
		url: input.baseUrl,
		folder: input.syncFolder,
	});
	if (!parsed.ok) return parsed;
	const params = new URLSearchParams();
	params.set('token', parsed.settings.apiToken);
	params.set('url', parsed.settings.baseUrl);
	params.set('folder', parsed.settings.syncFolder);
	return { ...parsed, link: `obsidian://${SETUP_ACTION}?${params.toString()}` };
}

/**
 * Read a setup link. Accepts the query object Obsidian passes to the protocol
 * handler, or the full `obsidian://` URL. `token` is required. `url` and
 * `folder` fall back to the public site and `oddava.me`.
 */
export function parseSetupLink(input: string | SetupParamSource): SetupParse {
	const params = paramsFrom(input);
	if (params === null) {
		return { ok: false, reason: 'That is not an Oddava Notes setup link.' };
	}

	const token = (params.token ?? '').trim();
	if (!token) {
		return { ok: false, reason: 'The setup link is missing a token.' };
	}
	if (token === PLACEHOLDER_TOKEN) {
		return {
			ok: false,
			reason: 'That token is the example placeholder. Generate a real one and open a new setup link.',
		};
	}
	if (token.length > 512) {
		return { ok: false, reason: 'The token in the setup link is longer than the site will read.' };
	}

	let baseUrl = DEFAULT_SETUP_URL;
	const urlParam = params.url?.trim() ?? '';
	if (urlParam) {
		const normalized = normalizeBaseUrl(urlParam);
		if (!normalized) {
			return { ok: false, reason: 'The site URL in the setup link is not a valid http(s) origin.' };
		}
		baseUrl = normalized;
	}

	let syncFolder = DEFAULT_SETUP_FOLDER;
	const folderParam = params.folder?.trim() ?? '';
	if (folderParam) {
		const folder = normalizeSyncFolder(folderParam);
		const problem = folderProblem(folder);
		if (problem) return { ok: false, reason: problem };
		syncFolder = folder;
	}

	return {
		ok: true,
		settings: { baseUrl, apiToken: token, syncFolder },
	};
}

type SetupParamSource = Record<string, string | undefined>;

function paramsFrom(input: string | SetupParamSource): SetupParamSource | null {
	if (typeof input !== 'string') return input;
	const trimmed = input.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== 'obsidian:' || url.hostname !== SETUP_ACTION) return null;
	const params: SetupParamSource = {};
	url.searchParams.forEach((value, key) => {
		params[key] = value;
	});
	return params;
}
