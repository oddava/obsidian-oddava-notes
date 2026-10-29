import { NotesApiError } from './errors';

const CODE_MESSAGES: Record<string, string> = {
	unauthorized: 'The API token was rejected. Check the token in settings.',
	notes_api_disabled:
		'The notes API is turned off. On the site, run `pnpm exec wrangler secret put NOTES_API_TOKEN`, then try again.',
	rate_limited: 'The site is rate limiting requests (120 per minute). Wait and try again.',
	revision_conflict: 'The site copy changed since this device last synced it.',
	path_exists: 'A note already exists at that path on the site.',
	slug_exists:
		'That file name is already used by another note. Names are unique across the whole garden, not just one folder.',
	invalid_path: 'The site rejected the path. Use lowercase kebab-case, like diary/hello.md.',
	invalid_content: 'The note body was not text.',
	invalid_revision: 'The revision sent to the site was not text.',
	invalid_request: 'The site could not read the request.',
	validation_failed:
		'The note frontmatter is not valid for the site. It only keeps title, icon, order, and updated. Icon must be one emoji or a site image path, and order must be a whole number.',
	payload_too_large: 'The note is larger than 1 MB, which the site does not accept.',
	not_found: 'That note is not on the site.',
	method_not_allowed: 'The site refused that request. This plugin does not delete notes.',
	content_store_unavailable: 'The site could not reach its note store.',
	content_busy: 'The site is busy saving something else. Try again in a moment.',
	rate_limit_unavailable: 'The site could not check its rate limit. Try again in a moment.',
	notes_api_unavailable: 'The notes API hit an unexpected error.',
	invalid_response: 'The site returned a note the plugin could not read.',
};

export function failureMessage(
	status: number,
	code: string | undefined,
	retryAfter: string | undefined,
	fields: readonly string[],
): string {
	const base = (code && CODE_MESSAGES[code]) ?? `The site returned HTTP ${status}.`;
	const withFields = fields.length > 0 ? `${base} Fields: ${fields.join(', ')}.` : base;
	if (code === 'rate_limited' && retryAfter) {
		return `${withFields} Retry after ${retryAfter}.`;
	}
	if (code === 'content_busy') {
		return withFields;
	}
	return withFields;
}

export function explainError(error: unknown): string {
	if (error instanceof NotesApiError) return error.message;
	if (error instanceof Error && error.message) return error.message;
	return 'Something went wrong talking to the site.';
}

/** Notices and thrown network errors must not echo the bearer token. */
export function redact(message: string, secret?: string): string {
	let result = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
	const token = secret?.trim();
	if (token && token.length >= 4) {
		result = result.split(token).join('[redacted]');
	}
	return result;
}

export function slugConflictMessage(otherPath: string | undefined): string {
	if (otherPath) {
		return `The file name is already used on the site at ${otherPath}. Names are unique across the whole garden, not just one folder. Nothing was overwritten.`;
	}
	return failureMessage(409, 'slug_exists', undefined, []);
}

export function conflictSavedMessage(conflictVaultPath: string): string {
	const name = conflictVaultPath.split('/').pop() ?? conflictVaultPath;
	return `The site copy changed. Saved it as "${name}". Your note and the site were both left as they are. Merge them, delete the conflict file, then publish again.`;
}

export function blockedConflictMessage(): string {
	return 'This note has a site conflict file open. Merge it into the note, delete the conflict file, then publish again.';
}
