import { describe, expect, it } from 'vitest';
import { FakeTelegram } from '../test/fake-telegram';
import {
	collectTags,
	metaLine,
	prepareTelegramPost,
	readingMinutes,
	sanitizeTag,
	type PrepareTelegramInput,
	type TelegramPostDraft,
	withTelegramRecord,
} from './telegram';
import { createTelegramApi } from './telegram-api';
import { replacePost, sendNewPost, updatePost, type TelegramPostEnv } from './telegram-post';
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from './telegram-format';

const token = '123456789:AA-real-token_ok';

function prepare(content: string, overrides: Partial<PrepareTelegramInput> = {}): TelegramPostDraft {
	const prepared = prepareTelegramPost({
		vaultPath: 'oddava.me/knowledge.md',
		syncFolder: 'oddava.me',
		content,
		baseUrl: 'https://oddava.me',
		channel: '@justoddava',
		publishedRevision: 'r1',
		...overrides,
	});
	if (!prepared.ok) throw new Error(prepared.reason);
	return prepared.draft;
}

function env(telegram: FakeTelegram, draft: TelegramPostDraft): TelegramPostEnv {
	return {
		api: createTelegramApi(telegram.http, token, { sleep: async () => {} }),
		chatId: '@justoddava',
		silent: draft.silent,
		pin: draft.pin,
		loadPhoto: async () => {
			throw new Error('no photos here');
		},
	};
}

const words = (count: number): string => Array.from({ length: count }, () => 'word').join(' ');

describe('reading time', () => {
	it('is at least one minute', () => {
		expect(readingMinutes('')).toBe(1);
		expect(readingMinutes('hello')).toBe(1);
	});

	it('uses 200 words a minute, rounded up', () => {
		expect(readingMinutes(words(200))).toBe(1);
		expect(readingMinutes(words(201))).toBe(2);
		expect(readingMinutes(words(600))).toBe(3);
	});

	it('ignores frontmatter and counts code blocks', () => {
		const frontmatter = `---\ntitle: ${words(500)}\n---\n`;
		expect(readingMinutes(`${frontmatter}${words(10)}`)).toBe(1);
		expect(readingMinutes(`${frontmatter}\`\`\`\n${words(250)}\n\`\`\`\n`)).toBe(2);
	});
});

describe('tags', () => {
	it('sanitises into Telegram hashtags', () => {
		expect(sanitizeTag('project/ideas')).toBe('project_ideas');
		expect(sanitizeTag('#to-do')).toBe('to_do');
		expect(sanitizeTag('café!')).toBe('café');
		expect(sanitizeTag('2024')).toBeNull();
		expect(sanitizeTag('!!!')).toBeNull();
		expect(sanitizeTag('2024-q1')).toBe('2024_q1');
	});

	it('reads list, inline list, and string frontmatter tags', () => {
		expect(collectTags('---\ntags:\n  - one\n  - two/sub\n---\nbody')).toEqual(['one', 'two_sub']);
		expect(collectTags('---\ntags: [one, "two"]\n---\nbody')).toEqual(['one', 'two']);
		expect(collectTags('---\ntags: one, two three\n---\nbody')).toEqual(['one', 'two', 'three']);
	});

	it('adds inline tags after frontmatter tags and removes repeats', () => {
		const content = '---\ntags: [obsidian]\n---\n# Title\n\nUses #notes and #Obsidian and #notes, also #123.';
		expect(collectTags(content)).toEqual(['obsidian', 'notes']);
	});

	it('does not read headings, code, or url fragments as tags', () => {
		const content = '# Heading\n\nSee https://x.dev/page#section.\n\n`#inline`\n\n```\n#fenced\n```\n\n#real';
		expect(collectTags(content)).toEqual(['real']);
	});
});

describe('meta line', () => {
	it('shows reading time and tags', () => {
		expect(metaLine(`---\ntags: [obsidian, notes]\n---\n${words(450)}`)).toBe('⏱ 3 min read · #obsidian #notes');
	});

	it('has no separator without tags', () => {
		expect(metaLine('Just a short note.')).toBe('⏱ 1 min read');
	});

	it('sits just above the link, in the post', () => {
		const draft = prepare('# Hi\n\nSome text here that is long enough. #tag\n', { showMeta: true });
		const html = draft.parts[0]?.text.html ?? '';
		expect(html).toMatch(/⏱ 1 min read · #tag\n\n<a href="[^"]+">Read on oddava\.me<\/a>$/);
	});

	it('is left out when the setting is off', () => {
		const draft = prepare('# Hi\n\nSome text here. #tag\n', { showMeta: false });
		expect(draft.parts[0]?.text.html).not.toContain('min read');
	});

	it('is added to summaries too', () => {
		const draft = prepare('# Hi\n\nSome text here. #tag\n', { showMeta: true, format: 'summary' });
		expect(draft.parts[0]?.text.html).toContain('⏱ 1 min read · #tag');
	});

	it('counts toward the length limit', () => {
		const body = Array.from({ length: 80 }, (_, index) => `Paragraph ${index} ${words(40)}`).join('\n\n');
		const content = `---\ntags: [${Array.from({ length: 30 }, (_, i) => `tag${i}`).join(', ')}]\n---\n# Long\n\n${body}\n`;
		const draft = prepare(content, { showMeta: true });
		expect(draft.parts.length).toBeGreaterThan(1);
		for (const part of draft.parts) expect(part.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
		const last = draft.parts[draft.parts.length - 1]?.text.html ?? '';
		expect(last).toContain('Read on oddava.me');
		expect(draft.parts.map((part) => part.text.html).join('\n')).toContain('#tag29');
	});

	it('still fits a photo caption', () => {
		const cover = { kind: 'url' as const, url: 'https://example.com/a.png', label: 'a.png' };
		const content = `# T\n\n${words(400)}\n\n#alpha #beta`;
		const draft = prepare(content, { showMeta: true, cover });
		expect(draft.parts[0]?.kind).toBe('photo');
		for (const part of draft.parts) {
			const limit = part.kind === 'photo' ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;
			expect(part.text.length).toBeLessThanOrEqual(limit);
		}
	});

	it('escapes HTML', () => {
		const draft = prepare('# T\n\nText\n', { showMeta: true });
		expect(draft.parts[0]?.text.html).not.toMatch(/<(?!\/?a\b|\/?b\b)/);
	});
});

describe('silent and pin overrides', () => {
	const note = (front: string): string => `---\n${front}\n---\n# Hi\n\nSome text for the post.\n`;

	it('uses the settings without frontmatter', () => {
		const draft = prepare('# Hi\n\nText.\n', { silent: true, pin: true });
		expect(draft.silent).toBe(true);
		expect(draft.pin).toBe(true);
		const plain = prepare('# Hi\n\nText.\n');
		expect(plain.silent).toBe(false);
		expect(plain.pin).toBe(false);
	});

	it('lets frontmatter win over the settings, both ways', () => {
		const off = prepare(note('telegram_silent: false\ntelegram_pin: false'), { silent: true, pin: true });
		expect(off.silent).toBe(false);
		expect(off.pin).toBe(false);
		const on = prepare(note('telegram_silent: true\ntelegram_pin: true'), { silent: false, pin: false });
		expect(on.silent).toBe(true);
		expect(on.pin).toBe(true);
	});

	it('ignores values that are not booleans', () => {
		const draft = prepare(note('telegram_silent: maybe\ntelegram_pin: 3'), { silent: true, pin: false });
		expect(draft.silent).toBe(true);
		expect(draft.pin).toBe(false);
	});

	it('sends the first message silently when asked', async () => {
		const telegram = new FakeTelegram();
		const draft = prepare(note('telegram_silent: true'));
		await sendNewPost(env(telegram, draft), draft);
		expect(telegram.channel()[0]?.silent).toBe(true);
	});
});

describe('pinning', () => {
	const long = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}. ${words(120)}`).join('\n\n');

	it('pins the first message of a multi-message post, silently', async () => {
		const telegram = new FakeTelegram();
		const draft = prepare(`---\ntelegram_pin: true\n---\n# Long\n\n${long}\n`);
		expect(draft.parts.length).toBeGreaterThan(1);
		const outcome = await sendNewPost(env(telegram, draft), draft);
		expect(outcome.ok).toBe(true);
		expect(outcome.pinned).toBe(true);
		expect(telegram.pins).toEqual([{ id: outcome.record?.messageIds[0], silent: true }]);
	});

	it('does not pin when pinning is off', async () => {
		const telegram = new FakeTelegram();
		const draft = prepare('# Hi\n\nSome text for the post.\n');
		await sendNewPost(env(telegram, draft), draft);
		expect(telegram.methods()).not.toContain('pinChatMessage');
	});

	it('pins on the first send but not on an edit', async () => {
		const telegram = new FakeTelegram();
		const first = prepare('---\ntelegram_pin: true\n---\n# Hi\n\nSome text for the post.\n');
		const sent = await sendNewPost(env(telegram, first), first);
		expect(telegram.pins).toHaveLength(1);

		const stored = withTelegramRecord(
			'---\ntelegram_pin: true\n---\n# Hi\n\nSome changed text for the post.\n',
			sent.record!,
		);
		const second = prepare(stored);
		const updated = await updatePost(env(telegram, second), second, { allowGrowth: true });
		expect(updated.ok).toBe(true);
		expect(updated.edited).toBe(1);
		expect(telegram.pins).toHaveLength(1);
		expect(telegram.methods().filter((method) => method === 'pinChatMessage')).toHaveLength(1);
	});

	it('keeps the post when pinning fails, tells why, and does not retry', async () => {
		const telegram = new FakeTelegram();
		telegram.fail('pinChatMessage', 'Bad Request: not enough rights to pin a message', { times: 5 });
		const draft = prepare('---\ntelegram_pin: true\n---\n# Hi\n\nSome text for the post.\n');
		const outcome = await sendNewPost(env(telegram, draft), draft);
		expect(outcome.ok).toBe(true);
		expect(outcome.pinned).toBe(false);
		expect(outcome.record?.messageIds).toHaveLength(1);
		expect(outcome.warnings.join(' ')).toMatch(/could not be pinned/);
		expect(outcome.warnings.join(' ')).toMatch(/not enough rights/);
		expect(outcome.warnings.join(' ')).toMatch(/Pin messages/);
		expect(telegram.methods().filter((method) => method === 'pinChatMessage')).toHaveLength(1);
		expect(telegram.channel()).toHaveLength(1);
	});

	it('pins the new first message when a post is replaced', async () => {
		const telegram = new FakeTelegram();
		const first = prepare('---\ntelegram_pin: true\n---\n# Hi\n\nSome text for the post.\n');
		const sent = await sendNewPost(env(telegram, first), first);
		const again = prepare(withTelegramRecord('---\ntelegram_pin: true\n---\n# Hi\n\nSome text for the post.\n', sent.record!));
		const replaced = await replacePost(env(telegram, again), again);
		expect(replaced.ok).toBe(true);
		expect(telegram.pins).toHaveLength(2);
		expect(telegram.pins[1]?.id).toBe(replaced.record?.messageIds[0]);
	});
});
