/**
 * Just enough YAML to read `updated` and to compare note bodies.
 * The site only keeps title, icon, order, and updated, and it rewrites them.
 * Body text is what "the same note" means.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(content: string): { raw: string | null; body: string } {
	const match = content.match(FRONTMATTER);
	const raw = match?.[1];
	if (match === null || raw === undefined) {
		return { raw: null, body: content };
	}
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
	messageId?: number;
	/** Fingerprint of the plain text last sent to Telegram. */
	hash?: string;
}

export function readTelegramFrontmatter(content: string): TelegramFrontmatter {
	const { raw } = splitFrontmatter(content);
	if (raw === null) return { enabled: false };
	const idRaw = readFrontmatterScalar(raw, 'telegram_message_id');
	const id = idRaw !== undefined && /^\d+$/.test(idRaw) ? Number(idRaw) : undefined;
	const hash = readFrontmatterScalar(raw, 'telegram_hash');
	return {
		enabled: readFrontmatterScalar(raw, 'telegram') === 'true',
		messageId: id !== undefined && id > 0 ? id : undefined,
		hash: hash || undefined,
	};
}

/**
 * The site drops every frontmatter key except title, icon, order, and updated.
 * A pull of the site copy would otherwise erase `telegram` and
 * `telegram_message_id`. Copy those keys back from the vault note when the
 * incoming text does not already have them. The note body is unchanged, so
 * revision checks still compare the writing.
 */
export function preserveTelegramFrontmatter(local: string, incoming: string): string {
	const kept = readTelegramFrontmatter(local);
	const incomingMeta = readTelegramFrontmatter(incoming);
	const updates: Record<string, string> = {};
	if (kept.enabled && !incomingMeta.enabled) updates.telegram = 'true';
	if (kept.messageId && !incomingMeta.messageId) {
		updates.telegram_message_id = String(kept.messageId);
	}
	if (kept.hash && !incomingMeta.hash) updates.telegram_hash = kept.hash;
	if (Object.keys(updates).length === 0) return incoming;
	return upsertFrontmatter(incoming, updates);
}

/** Set or replace scalar keys. Other keys, including title and updated, stay put. */
export function upsertFrontmatter(content: string, updates: Record<string, string>): string {
	const keys = Object.keys(updates);
	if (keys.length === 0) return content;
	const match = content.match(FRONTMATTER);
	if (match?.[1] === undefined || match.index === undefined) {
		const lines = keys.map((key) => `${key}: ${updates[key]}`);
		const body = content.length > 0 ? `\n${content.replace(/^\n/, '')}` : '';
		return `---\n${lines.join('\n')}\n---\n${body}`;
	}
	const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
	const lines = match[1].split(/\r?\n/);
	const seen = new Set<string>();
	const next = lines.map((line) => {
		const key = keys.find((candidate) => line.startsWith(`${candidate}:`));
		if (!key) return line;
		seen.add(key);
		return `${key}: ${updates[key]}`;
	});
	for (const key of keys) {
		if (!seen.has(key)) next.push(`${key}: ${updates[key]}`);
	}
	const block = `---${newline}${next.join(newline)}${newline}---${newline}`;
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
