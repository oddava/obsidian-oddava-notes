import { describe, expect, it } from 'vitest';
import { FakeTelegram, parseMultipart } from '../test/fake-telegram';
import { prepareTelegramPost, withTelegramRecord, type PrepareTelegramInput, type TelegramCover, type TelegramPostDraft } from './telegram';
import {
	classifyTelegramFailure,
	createTelegramApi,
	multipartRequest,
	normalizeTelegramChannel,
	TelegramApiError,
} from './telegram-api';
import { replacePost, sendNewPost, updatePost, type TelegramPostEnv } from './telegram-post';

const token = '123456789:AA-real-token_ok';
const long = 'i will keep notes about the stuff i am learning, ideas worth remembering later. ';
const cover: TelegramCover = { kind: 'vault', path: 'oddava.me/img/cover.png', label: 'cover.png', size: 4, mtime: 1 };

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

function longNote(paragraphs: number): string {
	return `# Long\n\n${Array.from({ length: paragraphs }, (_, index) => `Paragraph ${index}. ${long.repeat(4)}`).join('\n\n')}\n`;
}

function env(telegram: FakeTelegram, silent = false): TelegramPostEnv {
	return {
		api: createTelegramApi(telegram.http, token, { sleep: async () => {} }),
		chatId: '@justoddava',
		silent,
		loadPhoto: async (photo) =>
			photo.kind === 'url'
				? { kind: 'url', url: photo.url }
				: { kind: 'upload', data: new Uint8Array([1, 2, 3, 4]).buffer, fileName: photo.label, mimeType: 'image/png' },
	};
}

/** The draft as the next publish would see it, after the record was written. */
function after(content: string, draft: TelegramPostDraft, ids: number[], overrides: Partial<PrepareTelegramInput> = {}) {
	const stamped = withTelegramRecord(content, {
		messageIds: ids,
		hashes: draft.parts.map((part) => part.hash),
		media: draft.parts[0]?.kind === 'photo' ? 'photo' : undefined,
	});
	return { stamped, next: (text: string) => prepare(text, overrides) };
}

describe('telegram API client', () => {
	it('sends HTML with link preview options and keeps the token out of the payload', async () => {
		const telegram = new FakeTelegram(token);
		const api = createTelegramApi(telegram.http, token);
		const id = await api.sendMessage({
			chatId: 'justoddava',
			html: '<b>Hi</b>',
			linkPreview: { url: 'https://oddava.me/notes/hi', prefer_large_media: true },
			silent: true,
		});
		expect(id).toBe(100);
		const call = telegram.calls[0];
		expect(call?.request.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
		expect(call?.payload).toEqual({
			chat_id: '@justoddava',
			text: '<b>Hi</b>',
			parse_mode: 'HTML',
			link_preview_options: { url: 'https://oddava.me/notes/hi', prefer_large_media: true },
			disable_notification: true,
		});
		expect(call?.request.body).not.toContain(token);
	});

	it('waits out a rate limit and retries', async () => {
		const telegram = new FakeTelegram(token);
		telegram.fail('sendMessage', 'Too Many Requests: retry after 3', { status: 429, parameters: { retry_after: 3 } });
		const waits: number[] = [];
		const api = createTelegramApi(telegram.http, token, {
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		await expect(api.sendMessage({ chatId: '@justoddava', html: 'x' })).resolves.toBe(100);
		expect(waits).toEqual([3250]);

		telegram.fail('sendMessage', 'Too Many Requests: retry after 600', { status: 429, parameters: { retry_after: 600 } });
		await expect(api.sendMessage({ chatId: '@justoddava', html: 'x' })).rejects.toThrow(/600 seconds/);
	});

	it('uploads a vault photo as multipart with the caption', async () => {
		const telegram = new FakeTelegram(token);
		const api = createTelegramApi(telegram.http, token);
		await api.sendPhoto({
			chatId: '@justoddava',
			photo: { kind: 'upload', data: new Uint8Array([9, 9, 9]).buffer, fileName: 'cover.png', mimeType: 'image/png' },
			captionHtml: '<b>Café</b> — ok',
		});
		const call = telegram.calls[0];
		expect(call?.request.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
		expect(call?.request.body).toBeUndefined();
		expect(call?.payload).toMatchObject({
			chat_id: '@justoddava',
			caption: '<b>Café</b> — ok',
			parse_mode: 'HTML',
			photo: 'attach://photo',
			__file: 'cover.png:3',
		});
		expect(telegram.channel()[0]).toMatchObject({ kind: 'photo', text: '<b>Café</b> — ok' });
	});

	it('encodes nested fields as JSON in multipart', () => {
		const request = multipartRequest(
			{ chat_id: '@c', media: { type: 'photo', media: 'attach://photo' } },
			{ field: 'photo', data: new Uint8Array([1]).buffer, fileName: 'a"b.png', mimeType: 'image/png' },
			'BOUNDARY',
		);
		const fields = parseMultipart({ method: 'POST', url: '', headers: request.headers, bodyBytes: request.bodyBytes });
		expect(fields).toEqual({ chat_id: '@c', media: { type: 'photo', media: 'attach://photo' }, __file: 'a_b.png:1' });
	});

	it('explains failures without the token', () => {
		const cases: Array<[number, string, string]> = [
			[401, 'Unauthorized', 'auth'],
			[400, 'Bad Request: chat not found', 'chat'],
			[403, 'Forbidden: bot is not a member of the channel chat', 'rights'],
			[400, 'Bad Request: message is not modified', 'unchanged'],
			[400, 'Bad Request: message to edit not found', 'deleted'],
			[400, "Bad Request: message can't be deleted for everyone", 'not-editable'],
			[400, "Bad Request: can't parse entities: Unsupported start tag", 'parse'],
			[400, 'Bad Request: PHOTO_INVALID_DIMENSIONS', 'photo'],
			[400, 'Bad Request: failed to get HTTP URL content', 'photo'],
			[400, 'Bad Request: message is too long', 'too-long'],
		];
		for (const [status, description, kind] of cases) {
			expect(classifyTelegramFailure(status, { ok: false, description }).kind).toBe(kind);
		}
		const leaked = classifyTelegramFailure(400, { ok: false, description: `bad ${token}` }, token);
		expect(leaked.message).not.toContain(token);
	});

	it('reports a network failure without the token', async () => {
		const api = createTelegramApi(async () => {
			throw new Error(`failed https://api.telegram.org/bot${token}/sendMessage`);
		}, token);
		await expect(api.sendMessage({ chatId: '@justoddava', html: 'x' })).rejects.toThrow(/\[redacted\]/);
	});

	it('accepts t.me links as channels', () => {
		expect(normalizeTelegramChannel('https://t.me/justoddava')).toBe('@justoddava');
		expect(normalizeTelegramChannel('-1001234567890')).toBe('-1001234567890');
		expect(normalizeTelegramChannel('not a channel')).toBeNull();
	});
});

describe('posting a note', () => {
	it('sends a long note as consecutive messages, only the first with a sound', async () => {
		const telegram = new FakeTelegram(token);
		const draft = prepare(longNote(30));
		expect(draft.parts.length).toBeGreaterThan(1);
		const result = await sendNewPost(env(telegram), draft);
		expect(result.ok).toBe(true);
		const channel = telegram.channel();
		expect(channel).toHaveLength(draft.parts.length);
		expect(channel.map((message) => message.silent)).toEqual(channel.map((_, index) => index > 0));
		expect(channel.every((message) => message.parseMode === 'HTML')).toBe(true);
		expect(channel.at(-1)?.linkPreview).toMatchObject({ url: 'https://oddava.me/notes/knowledge' });
		expect(result.record).toEqual({
			messageIds: channel.map((message) => message.id),
			hashes: draft.parts.map((part) => part.hash),
			media: undefined,
		});
	});

	it('sends the cover photo with the caption, and falls back to text when Telegram refuses it', async () => {
		const telegram = new FakeTelegram(token);
		const draft = prepare(`# Hello\n\n${long}\n`, { cover });
		const sent = await sendNewPost(env(telegram), draft);
		expect(sent.ok).toBe(true);
		expect(sent.record?.media).toBe('photo');
		expect(telegram.channel()[0]).toMatchObject({ kind: 'photo', photo: 'upload:cover.png:4' });

		const refused = new FakeTelegram(token);
		refused.fail('sendPhoto', 'Bad Request: PHOTO_INVALID_DIMENSIONS');
		const fallback = await sendNewPost(env(refused), draft);
		expect(fallback.ok).toBe(true);
		expect(fallback.droppedPhoto).toBe(true);
		expect(fallback.record?.media).toBeUndefined();
		expect(fallback.warnings.join(' ')).toMatch(/without the cover image/);
		expect(refused.channel().map((message) => message.kind)).toEqual(['text']);
	});

	it('remembers the messages that went out when a later one fails', async () => {
		const telegram = new FakeTelegram(token);
		const draft = prepare(longNote(30));
		telegram.fail('sendMessage', 'Forbidden: bot was kicked from the channel chat', {
			status: 403,
			when: () => telegram.channel().length === 1,
		});
		const result = await sendNewPost(env(telegram), draft);
		expect(result.ok).toBe(false);
		expect(result.sent).toBe(1);
		expect(result.record?.messageIds).toEqual([100]);
		expect(result.error).toBeInstanceOf(TelegramApiError);
	});

	it('sends plain text when Telegram cannot read the formatting', async () => {
		const telegram = new FakeTelegram(token);
		telegram.fail('sendMessage', "Bad Request: can't parse entities: Can't find end tag", {
			when: (payload) => payload.parse_mode === 'HTML',
		});
		const draft = prepare(`# Hello\n\n**${long}**\n`);
		const result = await sendNewPost(env(telegram), draft);
		expect(result.ok).toBe(true);
		expect(result.warnings.join(' ')).toMatch(/plain text/);
		expect(telegram.channel()[0]).toMatchObject({ parseMode: undefined, text: draft.parts[0]?.text.plain });
	});
});

describe('updating a post', () => {
	it('edits only the messages that changed', async () => {
		const telegram = new FakeTelegram(token);
		const content = longNote(30);
		const draft = prepare(content);
		const sent = await sendNewPost(env(telegram), draft);
		const { stamped, next } = after(content, draft, sent.record?.messageIds ?? []);
		const edited = next(stamped.replace('Paragraph 29.', 'Paragraph 29, edited.'));
		expect(edited.change).toMatchObject({ kind: 'same', changed: [draft.parts.length - 1] });
		telegram.calls.length = 0;
		const result = await updatePost(env(telegram), edited, { allowGrowth: false });
		expect(result).toMatchObject({ ok: true, edited: 1, sent: 0, deleted: 0 });
		expect(telegram.methods()).toEqual(['editMessageText']);
		expect(telegram.channel().at(-1)?.text).toContain('Paragraph 29, edited.');
		expect(result.record?.hashes).toEqual(edited.parts.map((part) => part.hash));
	});

	it('adds replies when the note grew, and only with permission', async () => {
		const telegram = new FakeTelegram(token);
		const content = `# Hello\n\n${long}\n`;
		const draft = prepare(content);
		const sent = await sendNewPost(env(telegram), draft);
		const { stamped, next } = after(content, draft, sent.record?.messageIds ?? []);
		const grown = next(`${stamped}\n${longNote(30).replace('# Long\n\n', '')}`);
		expect(grown.change.kind).toBe('grows');

		const refused = await updatePost(env(telegram), grown, { allowGrowth: false });
		expect(refused.ok).toBe(false);
		expect(telegram.channel()).toHaveLength(1);

		const result = await updatePost(env(telegram), grown, { allowGrowth: true });
		expect(result.ok).toBe(true);
		const channel = telegram.channel();
		expect(channel).toHaveLength(grown.parts.length);
		expect(channel[1]?.replyTo).toBe(channel[0]?.id);
		expect(channel[2]?.replyTo).toBe(channel[1]?.id);
		expect(channel.slice(1).every((message) => message.silent)).toBe(true);
		expect(result.record?.messageIds).toEqual(channel.map((message) => message.id));
	});

	it('deletes the extra messages when the note got shorter', async () => {
		const telegram = new FakeTelegram(token);
		const content = longNote(30);
		const draft = prepare(content);
		const sent = await sendNewPost(env(telegram), draft);
		const ids = sent.record?.messageIds ?? [];
		const { next } = after(content, draft, ids);
		const short = next(withTelegramRecord(`# Long\n\n${long}\n`, sent.record ?? { messageIds: [], hashes: [] }));
		expect(short.change).toMatchObject({ kind: 'shrinks', to: 1 });
		const result = await updatePost(env(telegram), short, { allowGrowth: false });
		expect(result).toMatchObject({ ok: true, deleted: ids.length - 1 });
		expect(telegram.channel().map((message) => message.id)).toEqual([ids[0]]);
		expect(result.record?.messageIds).toEqual([ids[0]]);
	});

	it('re-uploads the photo only when the image changed', async () => {
		const telegram = new FakeTelegram(token);
		const content = `# Hello\n\n${long}\n`;
		const draft = prepare(content, { cover });
		const sent = await sendNewPost(env(telegram), draft);
		const { stamped } = after(content, draft, sent.record?.messageIds ?? [], { cover });

		const caption = prepare(stamped.replace(long, `${long} more`), { cover });
		telegram.calls.length = 0;
		await updatePost(env(telegram), caption, { allowGrowth: false });
		expect(telegram.methods()).toEqual(['editMessageCaption']);

		const newImage = prepare(stamped, { cover: { ...cover, mtime: 2 } });
		telegram.calls.length = 0;
		await updatePost(env(telegram), newImage, { allowGrowth: false });
		expect(telegram.methods()).toEqual(['editMessageMedia']);
	});

	it('says so when a message of the post was deleted in Telegram', async () => {
		const telegram = new FakeTelegram(token);
		const content = `# Hello\n\n${long}\n`;
		const draft = prepare(content);
		const sent = await sendNewPost(env(telegram), draft);
		telegram.messages.clear();
		const { stamped, next } = after(content, draft, sent.record?.messageIds ?? []);
		const result = await updatePost(env(telegram), next(stamped.replace(long, 'changed text that is long enough to post')), {
			allowGrowth: false,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatchObject({ kind: 'deleted' });
		expect(result.record).toBeNull();
	});
});

describe('replacing a post', () => {
	it('sends the new post first, then deletes the old messages', async () => {
		const telegram = new FakeTelegram(token);
		const content = `# Hello\n\n${long}\n`;
		const draft = prepare(content);
		const sent = await sendNewPost(env(telegram), draft);
		const { stamped } = after(content, draft, sent.record?.messageIds ?? []);
		const withCover = prepare(stamped, { cover });
		expect(withCover.change.kind).toBe('incompatible');
		telegram.calls.length = 0;
		const result = await replacePost(env(telegram), withCover);
		expect(result).toMatchObject({ ok: true, deleted: 1 });
		expect(telegram.methods()).toEqual(['sendPhoto', 'deleteMessage']);
		expect(telegram.channel().map((message) => message.kind)).toEqual(['photo']);
		expect(result.record?.media).toBe('photo');
	});

	it('keeps the old post when the new one fails, and warns when old messages cannot be deleted', async () => {
		const telegram = new FakeTelegram(token);
		const content = `# Hello\n\n${long}\n`;
		const draft = prepare(content);
		const sent = await sendNewPost(env(telegram), draft);
		const { stamped, next } = after(content, draft, sent.record?.messageIds ?? []);
		telegram.fail('sendMessage', 'Bad Request: chat not found');
		const failed = await replacePost(env(telegram), next(stamped));
		expect(failed.ok).toBe(false);
		expect(telegram.channel()).toHaveLength(1);

		telegram.fail('deleteMessage', "Bad Request: message can't be deleted for everyone");
		const replaced = await replacePost(env(telegram), next(stamped));
		expect(replaced.ok).toBe(true);
		expect(replaced.warnings.join(' ')).toMatch(/Could not delete the old message 100/);
	});
});
