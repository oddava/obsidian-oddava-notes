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
