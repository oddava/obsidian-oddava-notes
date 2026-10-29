/**
 * Vault paths stay in the sync folder (`oddava.me/diary/hello.md`).
 * The site identifies a note by the path under that folder (`diary/hello.md`).
 * Segments must be lowercase kebab-case, the same rule the notes API enforces.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONFLICT_SUFFIX = / \(site conflict(?: \d+)?\)\.md$/;

export type PathResult =
	| { ok: true; apiPath: string }
	| { ok: false; reason: string };

export function normalizeSyncFolder(value: string): string {
	return value
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\/{2,}/g, '/');
}

export function normalizeVaultPath(value: string): string {
	return value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

export function pathInsideSyncFolder(syncFolder: string, vaultPath: string): boolean {
	const folder = normalizeSyncFolder(syncFolder);
	const path = normalizeVaultPath(vaultPath);
	if (!folder || !path) return false;
	return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Where a note that lives outside the sync folder would sit after a move.
 * Keeps the vault-relative path, so `journal/hello.md` becomes `oddava.me/journal/hello.md`.
 */
export function destinationInSyncFolder(syncFolder: string, vaultPath: string): string | null {
	if (folderProblem(syncFolder)) return null;
	const folder = normalizeSyncFolder(syncFolder);
	const path = normalizeVaultPath(vaultPath);
	if (!path || path.endsWith('/') || pathInsideSyncFolder(folder, path)) return null;
	if (path.split('/').some((part) => part === '.' || part === '..' || part.length === 0)) {
		return null;
	}
	return `${folder}/${path}`;
}

export function folderProblem(syncFolder: string): string | null {
	const folder = normalizeSyncFolder(syncFolder);
	if (!folder) {
		return 'Set a vault folder to sync. The plugin does not publish the whole vault.';
	}
	if (folder.split('/').some((part) => part === '.' || part === '..' || part.length === 0)) {
		return "The sync folder cannot contain '.' or '..'.";
	}
	return null;
}

export function isSiteConflictFile(vaultPath: string): boolean {
	const name = vaultBasename(normalizeVaultPath(vaultPath));
	return CONFLICT_SUFFIX.test(name);
}

export function vaultBasename(vaultPath: string): string {
	const slash = vaultPath.lastIndexOf('/');
	return slash >= 0 ? vaultPath.slice(slash + 1) : vaultPath;
}

export function vaultDirectory(vaultPath: string): string {
	const slash = vaultPath.lastIndexOf('/');
	return slash >= 0 ? vaultPath.slice(0, slash) : '';
}

/** Turn a site path into the canonical `folder/note.md` form, or explain why it is unsafe to write. */
export function parseApiPath(input: string): PathResult {
	const valueWithSlashes = input.trim().replace(/\\/g, '/');
	// Reject absolute paths before stripping a leading slash, or `/etc/passwd`
	// becomes the innocent-looking note `etc/passwd.md`.
	if (
		!valueWithSlashes ||
		valueWithSlashes.startsWith('/') ||
		valueWithSlashes.includes('..') ||
		valueWithSlashes.includes(':')
	) {
		return { ok: false, reason: `The site path "${input}" is not a note this plugin will write.` };
	}
	let value = valueWithSlashes;

	if (value.endsWith('.md')) {
		value = value.slice(0, -'.md'.length);
	} else if (/\.[a-z0-9]+$/i.test(value)) {
		return { ok: false, reason: `The site path "${input}" is not a Markdown note.` };
	}

	if (!value || value.length > 512) {
		return { ok: false, reason: 'The site path is empty or too long.' };
	}

	const segments = value.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		return { ok: false, reason: `The site path "${input}" is not a note this plugin will write.` };
	}
	const bad = segments.find((segment) => !SLUG.test(segment));
	if (bad) {
		return {
			ok: false,
			reason: `The site path "${input}" is not lowercase kebab-case, so it was left alone.`,
		};
	}
	return { ok: true, apiPath: `${value}.md` };
}

export function vaultPathForApi(syncFolder: string, apiPath: string): string {
	const folder = normalizeSyncFolder(syncFolder);
	const parsed = parseApiPath(apiPath);
	if (!parsed.ok) {
		throw new Error(parsed.reason);
	}
	return `${folder}/${parsed.apiPath}`;
}

export function toApiPath(syncFolder: string, vaultPath: string): PathResult {
	const problem = folderProblem(syncFolder);
	if (problem) return { ok: false, reason: problem };

	const folder = normalizeSyncFolder(syncFolder);
	const path = normalizeVaultPath(vaultPath);
	if (!path || path.endsWith('/')) {
		return { ok: false, reason: 'Open a Markdown note to publish.' };
	}
	if (isSiteConflictFile(path)) {
		return {
			ok: false,
			reason:
				'This file is a conflict copy from the site. Merge it into the original note, delete it, and publish the original.',
		};
	}

	const prefix = `${folder}/`;
	if (path === folder || !path.startsWith(prefix)) {
		return {
			ok: false,
			reason: `This note is outside the sync folder "${folder}".`,
		};
	}

	const relative = path.slice(prefix.length);
	if (!relative.endsWith('.md')) {
		return { ok: false, reason: 'Only Markdown notes ending in .md can be published.' };
	}

	const parsed = parseApiPath(relative);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: `The site only accepts lowercase kebab-case paths, like diary/hello.md. "${relative}" is not allowed.`,
		};
	}
	return parsed;
}

export function hasOpenConflict(noteVaultPath: string, siblingNames: readonly string[]): boolean {
	const stem = vaultBasename(noteVaultPath).replace(/\.md$/i, '');
	const pattern = conflictPattern(stem);
	return siblingNames.some((name) => pattern.test(name));
}

export function nextConflictVaultPath(
	noteVaultPath: string,
	siblingNames: readonly string[],
): string {
	const normalized = normalizeVaultPath(noteVaultPath);
	const directory = vaultDirectory(normalized);
	const stem = vaultBasename(normalized).replace(/\.md$/i, '');
	const prefix = directory ? `${directory}/` : '';
	const taken = new Set(siblingNames);
	const first = `${stem} (site conflict).md`;
	if (!taken.has(first)) return `${prefix}${first}`;
	for (let n = 2; n < 100; n += 1) {
		const candidate = `${stem} (site conflict ${n}).md`;
		if (!taken.has(candidate)) return `${prefix}${candidate}`;
	}
	throw new Error(`Too many conflict copies already exist for ${stem}.md.`);
}

function conflictPattern(stem: string): RegExp {
	const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^${escaped} \\(site conflict(?: \\d+)?\\)\\.md$`);
}
