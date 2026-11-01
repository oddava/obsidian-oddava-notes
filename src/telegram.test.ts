import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { noteBodiesMatch, preserveTelegramFrontmatter, readTelegramFrontmatter, upsertFrontmatter } from './frontmatter';
import {
	compareLayout,
	coverCandidates,
	NEARLY_EMPTY_CHARS,
	prepareTelegramPost,
	publicNoteUrl,
	telegramFollowUp,
	withTelegramRecord,
	type PrepareTelegramInput,
	type TelegramCover,
	type TelegramPostDraft,
} from './telegram';
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from './telegram-format';

const folder = 'oddava.me';
const long = 'i will keep notes about the stuff i am learning, ideas worth remembering later.';
const cover: TelegramCover = { kind: 'vault', path: 'oddava.me/img/cover.png', label: 'cover.png', size: 1000, mtime: 1 };

function note(body: string, extra = ''): string {
	return `---\ntitle: Knowledge\ntelegram: true\n${extra}---\n\n# Knowledge\n\n${body}\n`;
}

function prepare(content: string, overrides: Partial<PrepareTelegramInput> = {}): TelegramPostDraft {
	const prepared = prepareTelegramPost({
		vaultPath: `${folder}/knowledge.md`,
		syncFolder: folder,
		content,
		baseUrl: 'https://oddava.me',
		channel: '@justoddava',
		publishedRevision: 'r1',
		...overrides,
	});
	if (!prepared.ok) throw new Error(prepared.reason);
	return prepared.draft;
}

function stamp(content: string, draft: TelegramPostDraft, ids: number[]): string {
	return withTelegramRecord(content, {
		messageIds: ids,
		hashes: draft.parts.map((part) => part.hash),
		media: draft.parts[0]?.kind === 'photo' ? 'photo' : undefined,
	});
}

describe('public note URL', () => {
	it('matches the site href', () => {
		expect(publicNoteUrl('https://oddava.me/', 'diary/hello.md')).toBe('https://oddava.me/notes/diary/hello');
		expect(publicNoteUrl('https://oddava.me', 'knowledge.md')).toBe('https://oddava.me/notes/knowledge');
		expect(publicNoteUrl('https://oddava.me', 'index.md')).toBe('https://oddava.me/notes');
	});
});

describe('telegram post text', () => {
	it('posts the full note by default, formatted, with the title once and a link at the end', () => {
		const content = `---\ntitle: Knowledge\nicon: 💡\n---\n\n# Knowledge\n\nLearn **this** & [that](https://example.com).\n\n- one\n- two\n\n## Later\n\nMore text.\n`;
		const draft = prepare(content);
		expect(draft.format).toBe('full');
		expect(draft.parts).toHaveLength(1);
		const [part] = draft.parts;
		expect(part?.kind).toBe('text');
		expect(part?.text.html).toBe(
			[
				'<b>Knowledge</b>',
				'Learn <b>this</b> &amp; <a href="https://example.com">that</a>.',
				'• one\n• two',
				'<b>Later</b>',
				'More text.',
				'<a href="https://oddava.me/notes/knowledge">Read on oddava.me</a>',
			].join('\n\n'),
		);
		expect(part?.text.html).not.toContain('icon');
		expect(part?.linkPreview).toEqual({ url: 'https://oddava.me/notes/knowledge', prefer_large_media: true });
	});

	it('posts a summary when the setting or the note asks for one', () => {
		const content = `# Hello\n\nLearn **this** & that.\n\nSecond paragraph that is not in a summary.\n`;
		const fromSetting = prepare(content, { format: 'summary' });
		expect(fromSetting.parts[0]?.text.html).toBe(
			'<b>Hello</b>\n\nLearn this &amp; that.\n\n<a href="https://oddava.me/notes/knowledge">Read on oddava.me</a>',
		);
		const fromNote = prepare(`---\ntelegram_format: summary\n---\n${content}`, { format: 'full' });
		expect(fromNote.format).toBe('summary');
		expect(fromNote.parts[0]?.text.plain).not.toContain('Second paragraph');
	});

	it('follows the link preview setting and the per-note override', () => {
		const content = `# Hello\n\n${long}\n`;
		expect(prepare(content, { linkPreview: 'small-above' }).parts[0]?.linkPreview).toEqual({
			url: 'https://oddava.me/notes/knowledge',
			prefer_small_media: true,
			show_above_text: true,
		});
		expect(prepare(`---\ntelegram_preview: off\n---\n${content}`).parts[0]?.linkPreview).toEqual({
			is_disabled: true,
		});
	});

	it('splits a long note into several messages and puts the preview on the last', () => {
		const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}. ${long.repeat(3)}`);
		const draft = prepare(`# Long\n\n${paragraphs.join('\n\n')}\n`);
		expect(draft.parts.length).toBeGreaterThan(1);
		for (const part of draft.parts) expect(part.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
		const previews = draft.parts.map((part) => part.linkPreview);
		expect(previews.slice(0, -1).every((preview) => preview?.is_disabled === true)).toBe(true);
		expect(previews.at(-1)?.url).toBe('https://oddava.me/notes/knowledge');
		expect(draft.parts.at(-1)?.text.plain.endsWith('Read on oddava.me')).toBe(true);
		expect(draft.parts.map((part) => part.text.plain).join('\n\n')).toContain('Paragraph 29.');
	});

	it('sends a cover photo first, with the post as its caption, and a text-only fallback', () => {
		const draft = prepare(`# Hello\n\n${long}\n`, { cover });
		expect(draft.parts).toHaveLength(1);
		expect(draft.parts[0]?.kind).toBe('photo');
		expect(draft.parts[0]?.linkPreview).toBeUndefined();
		expect(draft.textOnly?.[0]?.kind).toBe('text');

		const longer = prepare(`# Hello\n\n${Array.from({ length: 6 }, () => long.repeat(3)).join('\n\n')}\n`, { cover });
		expect(longer.parts[0]?.kind).toBe('photo');
		expect(longer.parts[0]?.text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
		expect(longer.parts.length).toBeGreaterThan(1);
		// The photo is the picture. No link card repeats it.
		expect(longer.parts.at(-1)?.linkPreview).toEqual({ is_disabled: true });
	});

	it('does not treat a missing revision as published', () => {
		const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/['"]pending['"]/);
		expect(source).toMatch(/Do not substitute a placeholder/);
		const missing = prepareTelegramPost({
			vaultPath: `${folder}/diary/hello.md`,
			syncFolder: folder,
			content: `# Hello\n\n${long}\n`,
			baseUrl: 'https://oddava.me',
			channel: '@justoddava',
			publishedRevision: '',
		});
		expect(missing.ok).toBe(false);
	});

	it('refuses a note outside the sync folder or not published yet', () => {
		const outside = prepareTelegramPost({
			vaultPath: 'inbox/hello.md',
			syncFolder: folder,
			content: `# Hello\n\n${long}\n`,
			baseUrl: 'https://oddava.me',
			channel: 'justoddava',
			publishedRevision: 'r1',
		});
		expect(outside.ok).toBe(false);
		if (outside.ok) return;
		expect(outside.reason).toMatch(/outside the sync folder/);

		const unpublished = prepareTelegramPost({
			vaultPath: `${folder}/diary/hello.md`,
			syncFolder: folder,
			content: `# Hello\n\n${long}\n`,
			baseUrl: 'https://oddava.me',
			channel: '@justoddava',
		});
		expect(unpublished.ok).toBe(false);
		if (unpublished.ok) return;
		expect(unpublished.reason).toMatch(/Publish this note/);
	});

	it('warns when the note was already posted and still offers a new post', () => {
		const draft = prepare(note(long, 'telegram_message_id: 42\ntelegram_hash: abc\n'));
		expect(draft.existing?.messageIds).toEqual([42]);
		expect(draft.warnings.join(' ')).toMatch(/message 42/);
		expect(draft.warnings.join(' ')).toMatch(/new one/);
		expect(draft.change).toEqual({ kind: 'same', changed: [0] });
		expect(draft.unchanged).toBe(false);
	});
});

describe('layout against the existing post', () => {
	it('knows when the post matches, grows, shrinks, or cannot be edited', () => {
		const short = prepare(`# Hello\n\n${long}\n`);
		const stamped = stamp(`# Hello\n\n${long}\n`, short, [7]);
		expect(prepare(stamped).unchanged).toBe(true);

		const grown = `${stamped}\n${Array.from({ length: 30 }, () => long.repeat(3)).join('\n\n')}\n`;
		expect(prepare(grown).change).toMatchObject({ kind: 'grows', from: 1 });

		const record = { messageIds: [7, 8, 9], hashes: ['a', 'b', 'c'] };
		expect(compareLayout(record, short.parts)).toEqual({ kind: 'shrinks', from: 3, to: 1, changed: [0] });
		expect(compareLayout(record, prepare(`# Hello\n\n${long}\n`, { cover }).parts).kind).toBe('incompatible');
		expect(compareLayout({ ...record, media: 'photo' }, short.parts).kind).toBe('incompatible');
	});
});

describe('telegram follow-up after publish', () => {
	it('does nothing on publish-on-save, even for a flagged note with an id', () => {
		const content = note(long, 'telegram_message_id: 7\n');
		const draft = prepare(content);
		expect(telegramFollowUp('autosave', content, draft)).toEqual({ kind: 'skip' });
		expect(telegramFollowUp('publish-and-post', content, draft)).toEqual({ kind: 'skip' });
	});

	it('skips a short flagged note and posts a long one that has no id yet', () => {
		expect(telegramFollowUp('command', note('too short'), prepare(note('too short')))).toEqual({
			kind: 'too-short',
			notice: expect.stringMatching(/too short/),
		});
		expect(long.length).toBeGreaterThanOrEqual(NEARLY_EMPTY_CHARS);
		expect(telegramFollowUp('command', note(long), prepare(note(long)))).toEqual({ kind: 'post' });
		const unflagged = note(long).replace('telegram: true\n', '');
		expect(telegramFollowUp('command', unflagged, prepare(unflagged))).toEqual({ kind: 'skip' });
	});

	it('edits an existing post only when a message changed', () => {
		const first = note(long);
		const same = stamp(first, prepare(first), [9]);
		expect(telegramFollowUp('command', same, prepare(same))).toEqual({ kind: 'edit', unchanged: true });
		const edited = same.replace(long, `${long} More.`);
		expect(telegramFollowUp('command', edited, prepare(edited))).toEqual({ kind: 'edit', unchanged: false });
	});

	it('asks before adding messages or swapping the photo', () => {
		const first = note(long);
		const same = stamp(first, prepare(first), [9]);
		const grown = `${same}\n${Array.from({ length: 30 }, () => long.repeat(3)).join('\n\n')}\n`;
		expect(telegramFollowUp('command', grown, prepare(grown))).toEqual({
			kind: 'confirm',
			notice: expect.stringMatching(/Run Post to Telegram/),
		});
		expect(telegramFollowUp('command', same, prepare(same, { cover }))).toEqual({
			kind: 'confirm',
			notice: expect.stringMatching(/replace the post/),
		});
	});
});

describe('telegram frontmatter record', () => {
	it('records every message id without dropping the site keys', () => {
		const original = `---\ntitle: Knowledge\nupdated: "2026-10-02T13:12:29.803Z"\norder: 2\n---\n\n# Knowledge\n\n${long}\n`;
		const stamped = withTelegramRecord(original, { messageIds: [42, 43], hashes: ['aa', 'bb'], media: 'photo' });
		const meta = readTelegramFrontmatter(stamped);
		expect(meta.messageId).toBe(42);
		expect(meta.messageIds).toEqual([42, 43]);
		expect(meta.hashes).toEqual(['aa', 'bb']);
		expect(meta.media).toBe('photo');
		expect(stamped).toContain('title: Knowledge');
		expect(stamped).toContain('updated: "2026-10-02T13:12:29.803Z"');
		expect(stamped).toContain('order: 2');
		expect(noteBodiesMatch(original, stamped)).toBe(true);

		const single = withTelegramRecord(stamped, { messageIds: [50], hashes: ['cc'] });
		expect(single).not.toContain('telegram_message_ids');
		expect(single).not.toContain('telegram_media');
		expect(readTelegramFrontmatter(single)).toMatchObject({ messageId: 50, messageIds: [50], hashes: ['cc'] });
	});

	it('reads notes from before multi-message posts', () => {
		const old = `---\ntelegram: true\ntelegram_message_id: 42\ntelegram_hash: abc\n---\n\n# Hi\n`;
		expect(readTelegramFrontmatter(old)).toMatchObject({ messageIds: [42], hashes: ['abc'], media: undefined });
		// A list that disagrees with the single id is stale.
		const stale = old.replace('telegram_hash', 'telegram_message_ids: 7,8\ntelegram_hash');
		expect(readTelegramFrontmatter(stale).messageIds).toEqual([42]);
	});

	it('puts the plugin keys back when a pull brings the site copy without them', () => {
		const local = upsertFrontmatter(`# Knowledge\n\n${long}\n`, {
			telegram: 'true',
			telegram_message_id: '42',
			telegram_message_ids: '42,43',
			telegram_media: 'photo',
			telegram_hash: 'abc,def',
			telegram_format: 'summary',
			telegram_image: '"[[cover.png]]"',
		});
		const site = `---\norder: 0\nupdated: "2026-10-29T18:00:00.000Z"\n---\n\n# Knowledge\n\n${long}\n`;
		const kept = preserveTelegramFrontmatter(local, site);
		expect(readTelegramFrontmatter(kept)).toMatchObject({
			enabled: true,
			messageIds: [42, 43],
			media: 'photo',
			hashes: ['abc', 'def'],
			format: 'summary',
			image: '[[cover.png]]',
		});
		expect(kept).toContain('updated: "2026-10-29T18:00:00.000Z"');
		expect(noteBodiesMatch(site, kept)).toBe(true);
	});
});

describe('cover candidates', () => {
	it('prefers telegram_image, then cover keys, then images in the body', () => {
		const content = `---\ncover: "[[img/cover.png]]"\nimage: https://cdn.example.com/a.jpg\n---\n\nText ![[shot.webp|300]] and ![alt](<img/my photo.jpg> "Title") and <img src="x.png">\n\n\`\`\`\n![[in-code.png]]\n\`\`\`\n`;
		expect(coverCandidates(content)).toEqual({
			disabled: false,
			explicit: undefined,
			candidates: ['img/cover.png', 'https://cdn.example.com/a.jpg', 'shot.webp', 'img/my photo.jpg', 'x.png'],
		});
		expect(coverCandidates(`---\ntelegram_image: pics/a.png\n---\n![[b.png]]`).explicit).toBe('pics/a.png');
		expect(coverCandidates(`---\ntelegram_image: false\n---\n![[b.png]]`)).toEqual({ disabled: true, candidates: [] });
	});
});
