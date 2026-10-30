import { describe, expect, it } from 'vitest';
import { contentFingerprint } from './fingerprint';
import { noteBodiesMatch, preserveTelegramFrontmatter, readTelegramFrontmatter, upsertFrontmatter } from './frontmatter';
import {
	editTelegramMessage,
	NEARLY_EMPTY_CHARS,
	plainPost,
	prepareTelegramPost,
	publicNoteUrl,
	sendTelegramMessage,
	telegramFollowUp,
	telegramHtml,
	withTelegramMessageId,
} from './telegram';
import type { HttpClient, HttpResponse } from './types';

const folder = 'oddava.me';
const token = '123456789:AA-real-token_ok';
const long =
	'i will keep notes about the stuff i am learning, ideas worth remembering later.';

function note(body: string, extra = ''): string {
	return `---\ntitle: Knowledge\ntelegram: true\n${extra}---\n\n# Knowledge\n\n${body}\n`;
}

function http(handler: (url: string, body: string) => HttpResponse): HttpClient {
	return async (request) => handler(request.url, request.body ?? '');
}

describe('public note URL', () => {
	it('matches the site href', () => {
		expect(publicNoteUrl('https://oddava.me/', 'diary/hello.md')).toBe(
			'https://oddava.me/notes/diary/hello',
		);
		expect(publicNoteUrl('https://oddava.me', 'knowledge.md')).toBe(
			'https://oddava.me/notes/knowledge',
		);
		expect(publicNoteUrl('https://oddava.me', 'index.md')).toBe('https://oddava.me/notes');
	});
});

describe('telegram post text', () => {
	it('bolds the title, strips frontmatter and markdown, and escapes HTML', () => {
		const content = `---\ntitle: A <b>title</b>\nicon: 💡\n---\n\n# ignored\n\nLearn **this** & [that](https://oddava.me).\n`;
		const prepared = prepareTelegramPost({
			vaultPath: `${folder}/diary/hello.md`,
			syncFolder: folder,
			content,
			baseUrl: 'https://oddava.me',
			channel: '@justoddava',
			publishedRevision: 'r1',
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.draft.title).toBe('A <b>title</b>');
		expect(prepared.draft.excerpt).toBe('Learn this & that.');
		expect(prepared.draft.url).toBe('https://oddava.me/notes/diary/hello');
		expect(prepared.draft.html).toBe(
			'<b>A &lt;b&gt;title&lt;/b&gt;</b>\n\nLearn this &amp; that.\n\nhttps://oddava.me/notes/diary/hello',
		);
		expect(prepared.draft.plain).toBe(plainPost(prepared.draft.title, prepared.draft.excerpt, prepared.draft.url));
		expect(prepared.draft.html).not.toContain('icon');
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
		const prepared = prepareTelegramPost({
			vaultPath: `${folder}/knowledge.md`,
			syncFolder: folder,
			content: note(long, 'telegram_message_id: 42\ntelegram_hash: abc\n'),
			baseUrl: 'https://oddava.me',
			channel: '@justoddava',
			publishedRevision: 'r1',
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.draft.messageId).toBe(42);
		expect(prepared.draft.warnings.join(' ')).toMatch(/message 42/);
		expect(prepared.draft.warnings.join(' ')).toMatch(/new one/);
	});
});

describe('telegram follow-up after publish', () => {
	const plain = plainPost('Knowledge', long, 'https://oddava.me/notes/knowledge');

	it('does nothing on publish-on-save, even for a flagged note with an id', () => {
		const content = note(long, 'telegram_message_id: 7\n');
		expect(telegramFollowUp('autosave', content, plain)).toEqual({ kind: 'skip' });
		expect(telegramFollowUp('publish-and-post', content, plain)).toEqual({ kind: 'skip' });
	});

	it('skips a short flagged note and posts a long one that has no id yet', () => {
		expect(telegramFollowUp('command', note('too short'), plain)).toEqual({
			kind: 'too-short',
			notice: expect.stringMatching(/too short/),
		});
		expect(long.length).toBeGreaterThanOrEqual(NEARLY_EMPTY_CHARS);
		expect(telegramFollowUp('command', note(long), plain)).toEqual({ kind: 'post' });
		expect(telegramFollowUp('command', note(long).replace('telegram: true\n', ''), plain)).toEqual({
			kind: 'skip',
		});
	});

	it('edits an existing post only when the rendered text changed', () => {
		const hash = contentFingerprint(plain);
		const same = note(long, `telegram_message_id: 9\ntelegram_hash: ${hash}\n`);
		expect(telegramFollowUp('command', same, plain)).toEqual({
			kind: 'edit',
			messageId: 9,
			unchanged: true,
		});
		const edited = note(`${long} More.`, `telegram_message_id: 9\ntelegram_hash: ${hash}\n`);
		const next = plainPost('Knowledge', `${long} More.`, 'https://oddava.me/notes/knowledge');
		expect(telegramFollowUp('command', edited, next)).toEqual({
			kind: 'edit',
			messageId: 9,
			unchanged: false,
		});
	});
});

describe('telegram frontmatter id', () => {
	it('records the message id without dropping the site keys', () => {
		const original = `---\ntitle: Knowledge\nupdated: "2026-10-02T13:12:29.803Z"\norder: 2\n---\n\n# Knowledge\n\n${long}\n`;
		const stamped = withTelegramMessageId(original, 42, 'plain text');
		expect(readTelegramFrontmatter(stamped).messageId).toBe(42);
		expect(stamped).toContain('title: Knowledge');
		expect(stamped).toContain('updated: "2026-10-02T13:12:29.803Z"');
		expect(stamped).toContain('order: 2');
		expect(stamped).toContain(long);
		expect(noteBodiesMatch(original, stamped)).toBe(true);
	});

	it('puts the id back when a pull brings the site copy without it', () => {
		const local = upsertFrontmatter(`# Knowledge\n\n${long}\n`, {
			telegram: 'true',
			telegram_message_id: '42',
			telegram_hash: 'abc',
		});
		const site = `---\norder: 0\nupdated: "2026-10-29T18:00:00.000Z"\n---\n\n# Knowledge\n\n${long}\n`;
		const kept = preserveTelegramFrontmatter(local, site);
		expect(readTelegramFrontmatter(kept)).toMatchObject({
			enabled: true,
			messageId: 42,
			hash: 'abc',
		});
		expect(kept).toContain('updated: "2026-10-29T18:00:00.000Z"');
		expect(noteBodiesMatch(site, kept)).toBe(true);
	});
});

describe('telegram API', () => {
	it('sends HTML and returns the message id without leaking the token', async () => {
		let seenUrl = '';
		let seen: Record<string, unknown> = {};
		const sent = await sendTelegramMessage(
			http((url, body) => {
				seenUrl = url;
				seen = JSON.parse(body) as Record<string, unknown>;
				return { status: 200, headers: {}, body: { ok: true, result: { message_id: 15 } } };
			}),
			{ token, chatId: '@justoddava', html: telegramHtml('Hi', 'there', 'https://oddava.me/notes/hi') },
		);
		expect(sent.messageId).toBe(15);
		expect(seen.parse_mode).toBe('HTML');
		expect(seen.text).toBe('<b>Hi</b>\n\nthere\n\nhttps://oddava.me/notes/hi');
		expect(seenUrl).toContain(token);
		expect(JSON.stringify(seen)).not.toContain(token);
	});

	it('treats an unchanged edit as success and a deleted message as a reason to re-post', async () => {
		const unchanged = await editTelegramMessage(
			http(() => ({
				status: 400,
				headers: {},
				body: { ok: false, description: 'Bad Request: message is not modified' },
			})),
			{ token, chatId: '@justoddava', messageId: 3, html: '<b>Hi</b>' },
		);
		expect(unchanged).toBe('unchanged');

		await expect(
			editTelegramMessage(
				http(() => ({
					status: 400,
					headers: {},
					body: { ok: false, description: 'Bad Request: message to edit not found' },
				})),
				{ token, chatId: '@justoddava', messageId: 3, html: '<b>Hi</b>' },
			),
		).rejects.toThrow(/deleted/);

		await expect(
			sendTelegramMessage(
				http(() => {
					throw new Error(`failed https://api.telegram.org/bot${token}/sendMessage`);
				}),
				{ token, chatId: '@justoddava', html: '<b>Hi</b>' },
			),
		).rejects.toThrow(/\[redacted\]/);
	});
});
