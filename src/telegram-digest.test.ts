import { describe, expect, it } from 'vitest';
import { FakeTelegram } from '../test/fake-telegram';
import { createTelegramApi } from './telegram-api';
import {
	buildDigest,
	DIGEST_MAX_NOTES,
	digestDateRange,
	recentDigestWarning,
	selectDigestNotes,
} from './telegram-digest';
import { TELEGRAM_TEXT_LIMIT } from './telegram-format';
import { defaultSettings, mergeSettings } from './settings-data';
import type { NoteSummary } from './types';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date(2026, 10, 3, 12, 0, 0).getTime();

function note(path: string, ageMs: number, title = path): NoteSummary {
	return { path, title, updated: new Date(now - ageMs).toISOString(), revision: `r-${path}` };
}

function paths(notes: NoteSummary[]): string[] {
	return notes.map((entry) => entry.path);
}

describe('selectDigestNotes', () => {
	it('keeps notes from the last 7 days and drops older ones', () => {
		const picked = selectDigestNotes(
			[note('new.md', DAY), note('edge.md', 7 * DAY - 1000), note('old.md', 7 * DAY + 1000)],
			[],
			{ now, excludeDiary: false },
		);
		expect(paths(picked)).toEqual(['new.md', 'edge.md']);
	});

	it('leaves out trashed notes', () => {
		const gone = note('gone.md', DAY);
		const picked = selectDigestNotes([note('a.md', DAY), gone], [gone], { now, excludeDiary: false });
		expect(paths(picked)).toEqual(['a.md']);
	});

	it('skips diary notes only when asked', () => {
		const list = [note('diary/today.md', DAY), note('Diary2/x.md', DAY), note('a.md', 2 * DAY)];
		expect(paths(selectDigestNotes(list, [], { now, excludeDiary: true }))).toEqual(['Diary2/x.md', 'a.md']);
		expect(paths(selectDigestNotes(list, [], { now, excludeDiary: false }))).toEqual([
			'diary/today.md',
			'Diary2/x.md',
			'a.md',
		]);
	});

	it('sorts newest first and ignores unreadable dates', () => {
		const list = [note('b.md', 3 * DAY), note('a.md', DAY), { ...note('bad.md', 0), updated: 'nope' }];
		expect(paths(selectDigestNotes(list, [], { now, excludeDiary: false }))).toEqual(['a.md', 'b.md']);
	});

	it('returns an empty list when nothing matches', () => {
		expect(selectDigestNotes([note('old.md', 30 * DAY)], [], { now, excludeDiary: true })).toEqual([]);
	});
});

describe('buildDigest', () => {
	const base = 'https://oddava.me';

	it('renders the header, date range, note links and the index link', () => {
		const digest = buildDigest({ notes: [note('hello.md', DAY, 'Hello'), note('a/b.md', 2 * DAY, 'B')], baseUrl: base, now });
		expect(digest.html).toBe(
			[
				'<b>This week on oddava.me</b>',
				'27 Oct – 3 Nov 2026',
				'',
				'• <a href="https://oddava.me/notes/hello">Hello</a>',
				'• <a href="https://oddava.me/notes/a/b">B</a>',
				'',
				'<a href="https://oddava.me/notes">All notes on oddava.me</a>',
			]
				.join('\n'),
		);
		expect(digest.shown).toBe(2);
		expect(digest.more).toBe(0);
	});

	it('shows reading time when known', () => {
		const digest = buildDigest({
			notes: [note('hello.md', DAY, 'Hello')],
			baseUrl: base,
			now,
			minutes: new Map([['hello.md', 3]]),
		});
		expect(digest.html).toContain('Hello</a> · ⏱ 3 min');
	});

	it('escapes titles and attributes', () => {
		const digest = buildDigest({ notes: [note('ab.md', DAY, 'Tom & <Jerry> "x"')], baseUrl: base, now });
		expect(digest.html).toContain('Tom &amp; &lt;Jerry&gt; "x"</a>');
		expect(digest.html).not.toContain('<Jerry>');
	});

	it('caps at 20 notes and adds the "more" line', () => {
		const notes = Array.from({ length: 23 }, (_, i) => note(`n${i}.md`, DAY + i * 1000));
		const digest = buildDigest({ notes, baseUrl: base, now });
		expect(digest.shown).toBe(DIGEST_MAX_NOTES);
		expect(digest.more).toBe(3);
		expect(digest.total).toBe(23);
		expect(digest.plain).toContain('…and 3 more on oddava.me');
		expect(digest.plain).not.toContain('n20');
	});

	it('has no "more" line when everything is shown', () => {
		const digest = buildDigest({ notes: [note('a.md', DAY)], baseUrl: base, now });
		expect(digest.plain).not.toContain('more on oddava.me');
	});

	it('drops notes from the end to fit 4096 characters', () => {
		const long = 'x'.repeat(400);
		const notes = Array.from({ length: 20 }, (_, i) => note(`n${i}.md`, DAY + i * 1000, `${i} ${long}`));
		const digest = buildDigest({ notes, baseUrl: base, now });
		expect(digest.plain.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
		expect(digest.shown).toBeLessThan(20);
		expect(digest.more).toBe(20 - digest.shown);
		expect(digest.plain).toContain(`…and ${digest.more} more on oddava.me`);
		expect(digest.plain).toContain(`${digest.shown - 1} xxx`);
		expect(digest.plain).not.toContain(`\n• ${digest.shown} xxx`);
		expect(digest.html.endsWith('All notes on oddava.me</a>')).toBe(true);
	});
});

describe('digestDateRange', () => {
	it('shows day and month with the year once', () => {
		expect(digestDateRange(now)).toBe('27 Oct – 3 Nov 2026');
	});

	it('shows both years across new year', () => {
		expect(digestDateRange(new Date(2027, 0, 3, 12).getTime())).toBe('27 Dec 2026 – 3 Jan 2027');
	});
});

describe('recentDigestWarning', () => {
	it('is quiet before the first digest', () => {
		expect(recentDigestWarning(null, now)).toBeNull();
	});

	it('warns when the last digest is under 6 days old', () => {
		const warning = recentDigestWarning({ sentAt: now - 2 * DAY - 1000, messageId: 7 }, now);
		expect(warning).toEqual({ daysAgo: 2, messageId: 7 });
		expect(recentDigestWarning({ sentAt: now - 6 * DAY + 1000, messageId: 7 }, now)).not.toBeNull();
	});

	it('does not warn at 6 days or more', () => {
		expect(recentDigestWarning({ sentAt: now - 6 * DAY, messageId: 7 }, now)).toBeNull();
		expect(recentDigestWarning({ sentAt: now - 20 * DAY, messageId: 7 }, now)).toBeNull();
	});
});

describe('digest settings', () => {
	it('excludes the diary by default and has no last digest', () => {
		const settings = defaultSettings();
		expect(settings.telegramDigestExcludeDiary).toBe(true);
		expect(settings.lastDigest).toBeNull();
	});

	it('keeps saved values and drops malformed ones', () => {
		const saved = mergeSettings({ telegramDigestExcludeDiary: false, lastDigest: { sentAt: 5, messageId: 9 } });
		expect(saved.telegramDigestExcludeDiary).toBe(false);
		expect(saved.lastDigest).toEqual({ sentAt: 5, messageId: 9 });
		expect(mergeSettings({ lastDigest: { sentAt: 'x', messageId: 1 } }).lastDigest).toBeNull();
	});
});

describe('sending the digest', () => {
	it('sends one HTML message with no link preview and no pin', async () => {
		const telegram = new FakeTelegram();
		const api = createTelegramApi(telegram.http, telegram.token, { sleep: async () => {} });
		const digest = buildDigest({ notes: [note('a.md', DAY, 'A')], baseUrl: 'https://oddava.me', now });
		const id = await api.sendMessage({
			chatId: '@justoddava',
			html: digest.html,
			linkPreview: { is_disabled: true },
			silent: true,
		});
		expect(telegram.methods()).toEqual(['sendMessage']);
		const message = telegram.messages.get(id);
		expect(message?.parseMode).toBe('HTML');
		expect(message?.silent).toBe(true);
		expect(message?.linkPreview).toEqual({ is_disabled: true });
		expect(telegram.pins).toEqual([]);
	});
});
