/**
 * Just enough YAML to read `updated` and to compare note bodies.
 * The site only keeps title, icon, order, and updated, and it rewrites them.
 * Body text is what "the same note" means.
 */

// The inner group is optional so an emptied block (`---\n---`) still counts.
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;

export function splitFrontmatter(content: string): { raw: string | null; body: string } {
	const match = content.match(FRONTMATTER);
	if (match === null) {
		return { raw: null, body: content };
	}
	const raw = match[1] ?? '';
	const body = content.slice(match[0].length).replace(/^\r?\n/, '');
	return { raw, body };
}

export function readFrontmatterScalar(raw: string, key: string): string | undefined {
	const pattern = new RegExp(`^${key}:\\s*(.*)$`);
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(pattern);
		const captured = match?.[1];
		if (captured === undefined) continue;
		let value = captured.trim();
		if (!value || value === '|' || value === '>' || value === 'null' || value === '~') {
			return undefined;
		}
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		return value;
	}
	return undefined;
}

export function readUpdated(content: string): string | undefined {
	const { raw } = splitFrontmatter(content);
	if (raw === null) return undefined;
	return readFrontmatterScalar(raw, 'updated');
}

export interface TelegramFrontmatter {
	/** `telegram: true` opts the note in. Anything else is off. */
	enabled: boolean;
	/** First message of the post. Older notes only have this one. */
	messageId?: number;
	/** Every message of the post, in channel order. */
	messageIds: number[];
	/** `photo` when the first message is the cover photo with a caption. */
	media?: 'photo';
	/** Raw `telegram_hash`: one fingerprint per message, comma separated. */
	hash?: string;
	hashes: string[];
	/** `telegram_format`: `full` or `summary`. Overrides the setting. */
	format?: string;
	/** `telegram_image`: a vault path, wikilink, or URL. `false` sends no photo. */
	image?: string;
	/** `telegram_preview`: link preview override, such as `off` or `small-above`. */
	preview?: string;
}

/** Keys the plugin owns. A pull from the site must not lose them. */
export const TELEGRAM_KEYS = [
	'telegram',
	'telegram_message_id',
	'telegram_message_ids',
	'telegram_media',
	'telegram_hash',
	'telegram_format',
	'telegram_image',
	'telegram_preview',
] as const;

export function readTelegramFrontmatter(content: string): TelegramFrontmatter {
	const { raw } = splitFrontmatter(content);
	if (raw === null) return { enabled: false, messageIds: [], hashes: [] };
	const first = positiveId(readFrontmatterScalar(raw, 'telegram_message_id'));
	const listed = (readFrontmatterScalar(raw, 'telegram_message_ids') ?? '')
		.split(/[,\s]+/)
		.map(positiveId)
		.filter((id): id is number => id !== undefined);
	let messageIds = listed;
	if (first !== undefined && (listed.length === 0 || listed[0] !== first)) {
		// telegram_message_id is the source of truth for the first message.
		// A list that disagrees with it is stale; trust the single id.
		messageIds = [first];
	}
	const hash = readFrontmatterScalar(raw, 'telegram_hash') || undefined;
	const media = readFrontmatterScalar(raw, 'telegram_media') === 'photo' ? 'photo' : undefined;
	return {
		enabled: readFrontmatterScalar(raw, 'telegram') === 'true',
		messageId: messageIds[0],
		messageIds,
		media: messageIds.length > 0 ? media : undefined,
		hash,
		hashes: hash ? hash.split(',').map((part) => part.trim()).filter(Boolean) : [],
		format: readFrontmatterScalar(raw, 'telegram_format')?.toLowerCase(),
		image: readFrontmatterScalar(raw, 'telegram_image'),
		preview: readFrontmatterScalar(raw, 'telegram_preview')?.toLowerCase(),
	};
}

function positiveId(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d{1,15}$/.test(value.trim())) return undefined;
	const id = Number(value.trim());
	return id > 0 ? id : undefined;
}

/**
 * The site drops every frontmatter key except title, icon, order, and updated.
 * A pull of the site copy would otherwise erase `telegram` and the stored
 * message ids. Copy the plugin's keys back from the vault note when the
 * incoming text does not already have them. The note body is unchanged, so
 * revision checks still compare the writing.
 */
export function preserveTelegramFrontmatter(local: string, incoming: string): string {
	const localRaw = splitFrontmatter(local).raw;
	if (localRaw === null) return incoming;
	const incomingRaw = splitFrontmatter(incoming).raw;
	const updates: Record<string, string> = {};
	for (const key of TELEGRAM_KEYS) {
		const line = rawLine(localRaw, key);
		if (line === undefined) continue;
		if (incomingRaw !== null && rawLine(incomingRaw, key) !== undefined) continue;
		updates[key] = line;
	}
	if (Object.keys(updates).length === 0) return incoming;
	return upsertFrontmatter(incoming, updates);
}

/** The value text of `key: value` exactly as written, quotes included. */
function rawLine(raw: string, key: string): string | undefined {
	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith(`${key}:`)) continue;
		const value = line.slice(key.length + 1).trim();
		return value || undefined;
	}
	return undefined;
}

/**
 * Set or replace scalar keys. Other keys, including title and updated, stay
 * put. A `null` value removes the key.
 */
export function upsertFrontmatter(content: string, updates: Record<string, string | null>): string {
	const keys = Object.keys(updates);
	if (keys.length === 0) return content;
	const match = content.match(FRONTMATTER);
	if (!match || match.index === undefined) {
		const lines = keys.filter((key) => updates[key] !== null).map((key) => `${key}: ${updates[key]}`);
		if (lines.length === 0) return content;
		const body = content.length > 0 ? `\n${content.replace(/^\n/, '')}` : '';
		return `---\n${lines.join('\n')}\n---\n${body}`;
	}
	const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
	const lines = match[1] === undefined || match[1] === '' ? [] : match[1].split(/\r?\n/);
	const seen = new Set<string>();
	const next: string[] = [];
	for (const line of lines) {
		const key = keys.find((candidate) => line.startsWith(`${candidate}:`));
		if (!key) {
			next.push(line);
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		const value = updates[key];
		if (value === null || value === undefined) continue;
		next.push(`${key}: ${value}`);
	}
	for (const key of keys) {
		const value = updates[key];
		if (!seen.has(key) && value !== null && value !== undefined) next.push(`${key}: ${value}`);
	}
	const inner = next.length > 0 ? `${next.join(newline)}${newline}` : '';
	const block = `---${newline}${inner}---${newline}`;
	const after = content.slice(match.index + match[0].length);
	return content.slice(0, match.index) + block + after;
}

export function noteBodiesMatch(left: string, right: string): boolean {
	return normalizeBody(splitFrontmatter(left).body) === normalizeBody(splitFrontmatter(right).body);
}

function normalizeBody(body: string): string {
	return body.replace(/\r\n/g, '\n').trim();
}

export function isRemoteNewer(remoteUpdated: string | undefined, localUpdated: string | undefined): boolean {
	return compareTime(remoteUpdated, localUpdated) === 'gt';
}

export function isLocalNewer(localUpdated: string | undefined, remoteUpdated: string | undefined): boolean {
	return compareTime(localUpdated, remoteUpdated) === 'gt';
}

function compareTime(left: string | undefined, right: string | undefined): 'gt' | 'lt' | 'unknown' {
	if (!left || !right) return 'unknown';
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return 'unknown';
	if (leftTime > rightTime) return 'gt';
	if (leftTime < rightTime) return 'lt';
	return 'unknown';
}
