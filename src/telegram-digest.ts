import { publicNoteUrl } from './telegram';
import { runsToHtml, runsToPlain, TELEGRAM_TEXT_LIMIT, visibleLength, type Run } from './telegram-format';
import type { NoteSummary } from './types';

/** Notes updated within this many days are in the digest. */
export const DIGEST_WINDOW_DAYS = 7;
/** At most this many notes are listed. The rest go into the "…and N more" line. */
export const DIGEST_MAX_NOTES = 20;
/** A digest sent more recently than this triggers a warning in the preview. */
export const DIGEST_WARN_DAYS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** What plugin data remembers about the last digest. Not stored in any note. */
export interface DigestRecord {
	/** Epoch milliseconds of the send. */
	sentAt: number;
	messageId: number;
}

export interface DigestSelectionOptions {
	now: number;
	excludeDiary: boolean;
}

/**
 * Notes updated in the last 7 days, newest first. Trashed notes and, when
 * asked, the diary are left out. Not capped: the cap is applied when rendering.
 */
export function selectDigestNotes(
	notes: readonly NoteSummary[],
	deleted: readonly NoteSummary[],
	options: DigestSelectionOptions,
): NoteSummary[] {
	const trashed = new Set(deleted.map((note) => note.path));
	const since = options.now - DIGEST_WINDOW_DAYS * DAY_MS;
	return notes
		.map((note) => ({ note, time: Date.parse(note.updated) }))
		.filter(({ note, time }) => {
			if (!Number.isFinite(time) || time < since || time > options.now) return false;
			if (trashed.has(note.path)) return false;
			if (options.excludeDiary && isDiaryPath(note.path)) return false;
			return true;
		})
		.sort((left, right) => right.time - left.time || left.note.path.localeCompare(right.note.path))
		.map(({ note }) => note);
}

export function isDiaryPath(path: string): boolean {
	return path.replace(/^\/+/, '').toLowerCase().startsWith('diary/');
}

/** `27 Oct – 3 Nov 2026`, or with both years when the range crosses new year. */
export function digestDateRange(now: number): string {
	const end = new Date(now);
	const start = new Date(now - DIGEST_WINDOW_DAYS * DAY_MS);
	const day = (date: Date): string => `${date.getDate()} ${MONTHS[date.getMonth()]}`;
	if (start.getFullYear() !== end.getFullYear()) {
		return `${day(start)} ${start.getFullYear()} – ${day(end)} ${end.getFullYear()}`;
	}
	return `${day(start)} – ${day(end)} ${end.getFullYear()}`;
}

export interface DigestInput {
	/** Already selected and sorted. */
	notes: readonly NoteSummary[];
	baseUrl: string;
	now: number;
	/** Reading time in minutes by site path, when the note body is known. */
	minutes?: ReadonlyMap<string, number>;
}

export interface Digest {
	html: string;
	plain: string;
	runs: Run[];
	/** Notes with a line of their own. */
	shown: number;
	/** Notes in the "…and N more" line. */
	more: number;
	/** Notes selected, shown or not. */
	total: number;
}

/** Build the digest, dropping notes from the end until it fits Telegram's limit. */
export function buildDigest(input: DigestInput): Digest {
	const indexUrl = publicNoteUrl(input.baseUrl, 'index') ?? 'https://oddava.me/notes';
	const total = input.notes.length;
	let shown = Math.min(total, DIGEST_MAX_NOTES);
	let runs = render(input, shown, indexUrl);
	while (shown > 0 && visibleLength(runs) > TELEGRAM_TEXT_LIMIT) {
		shown -= 1;
		runs = render(input, shown, indexUrl);
	}
	return { html: runsToHtml(runs), plain: runsToPlain(runs), runs, shown, more: total - shown, total };
}

function render(input: DigestInput, shown: number, indexUrl: string): Run[] {
	const runs: Run[] = [
		{ text: 'This week on oddava.me', marks: [{ type: 'b' }] },
		{ text: `\n${digestDateRange(input.now)}\n`, marks: [] },
	];
	for (const note of input.notes.slice(0, shown)) {
		const url = publicNoteUrl(input.baseUrl, note.path);
		const title = note.title.trim() || note.path.replace(/\.md$/i, '').split('/').pop() || note.path;
		runs.push({ text: '\n• ', marks: [] });
		runs.push({ text: title, marks: url ? [{ type: 'a', href: url }] : [] });
		const minutes = input.minutes?.get(note.path);
		if (minutes !== undefined) runs.push({ text: ` · ⏱ ${minutes} min`, marks: [] });
	}
	const more = input.notes.length - shown;
	if (more > 0) runs.push({ text: `\n…and ${more} more on oddava.me`, marks: [] });
	runs.push({ text: '\n\n', marks: [] });
	runs.push({ text: 'All notes on oddava.me', marks: [{ type: 'a', href: indexUrl }] });
	return runs;
}

export interface DigestWarning {
	daysAgo: number;
	messageId: number;
}

/** A warning when the last digest went out less than 6 days ago. Never blocks sending. */
export function recentDigestWarning(last: DigestRecord | null, now: number): DigestWarning | null {
	if (!last || !Number.isFinite(last.sentAt)) return null;
	const age = now - last.sentAt;
	// A send time in the future (clock change) still counts as recent.
	if (age >= DIGEST_WARN_DAYS * DAY_MS) return null;
	return { daysAgo: Math.max(0, Math.floor(age / DAY_MS)), messageId: last.messageId };
}

export function describeDigestWarning(warning: DigestWarning): string {
	const when =
		warning.daysAgo === 0 ? 'today' : warning.daysAgo === 1 ? '1 day ago' : `${warning.daysAgo} days ago`;
	return `A digest was already sent ${when}. Send another only if you mean to.`;
}
