import { redact } from './messages';
import type { HttpClient } from './types';

/**
 * A small Telegram Bot API client. Every call goes through the injected
 * HttpClient (Obsidian `requestUrl` in production), so it works on mobile.
 */

export type TelegramErrorKind =
	| 'unchanged'
	| 'deleted'
	| 'not-editable'
	| 'photo'
	| 'parse'
	| 'too-long'
	| 'auth'
	| 'chat'
	| 'rights'
	| 'rate'
	| 'network'
	| 'other';

export class TelegramApiError extends Error {
	constructor(
		message: string,
		readonly kind: TelegramErrorKind,
		readonly status = 0,
		readonly description = '',
		readonly retryAfter?: number,
	) {
		super(message);
		this.name = 'TelegramApiError';
	}
}

export interface LinkPreviewOptions {
	is_disabled?: boolean;
	url?: string;
	prefer_small_media?: boolean;
	prefer_large_media?: boolean;
	show_above_text?: boolean;
}

export type TelegramPhotoInput =
	| { kind: 'url'; url: string }
	| { kind: 'upload'; data: ArrayBuffer; fileName: string; mimeType: string };

export interface TelegramApiOptions {
	/** Waits between retries. Tests pass a fake. */
	sleep?: (ms: number) => Promise<void>;
	/** Longest Telegram-requested wait that is retried automatically. */
	maxRetryAfterSeconds?: number;
	maxAttempts?: number;
}

export interface TelegramChat {
	id: number;
	title?: string;
	username?: string;
	type: string;
}

export interface TelegramChatMember {
	status: string;
	can_post_messages?: boolean;
	can_edit_messages?: boolean;
	can_delete_messages?: boolean;
}

/**
 * Bot tokens from BotFather look like `123456789:AA...`.
 * Anything else is refused before a request is built, so a pasted sentence
 * cannot change the Telegram URL.
 */
export function telegramTokenProblem(token: string): string | null {
	const trimmed = token.trim();
	if (!trimmed) return 'Add the Telegram bot token in settings.';
	if (!/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) {
		return 'The Telegram bot token does not look like a token from BotFather.';
	}
	return null;
}

/** `@channel` or a numeric id such as `-1001234567890`. Usernames may omit the @. */
export function normalizeTelegramChannel(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^-?\d{5,20}$/.test(trimmed)) return trimmed;
	const fromLink = trimmed.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i);
	const withAt = fromLink ? `@${fromLink[1]}` : trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
	if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(withAt)) return withAt;
	return null;
}

export function createTelegramApi(http: HttpClient, token: string, options: TelegramApiOptions = {}) {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const maxRetryAfter = options.maxRetryAfterSeconds ?? 60;
	const maxAttempts = options.maxAttempts ?? 4;
	const trimmed = token.trim();

	async function call(method: string, payload: Record<string, unknown>, upload?: Upload): Promise<unknown> {
		const tokenProblem = telegramTokenProblem(trimmed);
		if (tokenProblem) throw new TelegramApiError(tokenProblem, 'auth');
		const url = `https://api.telegram.org/bot${trimmed}/${method}`;
		for (let attempt = 1; ; attempt += 1) {
			let status = 0;
			let body: unknown;
			try {
				const request = upload ? multipartRequest(payload, upload) : jsonRequest(payload);
				const response = await http({ method: 'POST', url, ...request });
				status = response.status;
				body = response.body;
			} catch (error) {
				const message = error instanceof Error && error.message ? error.message : 'Could not reach Telegram.';
				throw new TelegramApiError(
					redact(`Could not reach Telegram. ${message}`, trimmed),
					'network',
				);
			}
			if (isRecord(body) && body.ok === true) return body.result;
			const failure = classifyTelegramFailure(status, body, trimmed);
			if (
				failure.kind === 'rate' &&
				failure.retryAfter !== undefined &&
				failure.retryAfter <= maxRetryAfter &&
				attempt < maxAttempts
			) {
				await sleep((failure.retryAfter + 0.25) * 1000);
				continue;
			}
			throw failure;
		}
	}

	function chat(chatId: string): string {
		const normalized = normalizeTelegramChannel(chatId);
		if (!normalized) throw new TelegramApiError('Set a Telegram channel, like @justoddava.', 'chat');
		return normalized;
	}

	return {
		async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
			const result = await call('getMe', {});
			if (!isRecord(result) || typeof result.id !== 'number') {
				throw new TelegramApiError('Telegram did not describe the bot.', 'other');
			}
			return {
				id: result.id,
				username: typeof result.username === 'string' ? result.username : undefined,
				first_name: typeof result.first_name === 'string' ? result.first_name : undefined,
			};
		},

		async getChat(chatId: string): Promise<TelegramChat> {
			const result = await call('getChat', { chat_id: chat(chatId) });
			if (!isRecord(result) || typeof result.id !== 'number') {
				throw new TelegramApiError('Telegram did not describe the channel.', 'other');
			}
			return {
				id: result.id,
				title: typeof result.title === 'string' ? result.title : undefined,
				username: typeof result.username === 'string' ? result.username : undefined,
				type: typeof result.type === 'string' ? result.type : 'unknown',
			};
		},

		async getChatMember(chatId: string, userId: number): Promise<TelegramChatMember> {
			const result = await call('getChatMember', { chat_id: chat(chatId), user_id: userId });
			if (!isRecord(result) || typeof result.status !== 'string') {
				throw new TelegramApiError('Telegram did not describe the bot’s rights.', 'other');
			}
			return {
				status: result.status,
				can_post_messages: result.can_post_messages === true,
				can_edit_messages: result.can_edit_messages === true,
				can_delete_messages: result.can_delete_messages === true,
			};
		},

		async sendMessage(input: {
			chatId: string;
			html: string;
			/** Without HTML parsing. Used when Telegram rejects the formatting. */
			plain?: boolean;
			linkPreview?: LinkPreviewOptions;
			silent?: boolean;
			replyTo?: number;
		}): Promise<number> {
			const result = await call('sendMessage', {
				chat_id: chat(input.chatId),
				text: input.html,
				...(input.plain ? {} : { parse_mode: 'HTML' }),
				...(input.linkPreview ? { link_preview_options: input.linkPreview } : {}),
				...(input.silent ? { disable_notification: true } : {}),
				...replyParameters(input.replyTo),
			});
			return messageIdOf(result);
		},

		async sendPhoto(input: {
			chatId: string;
			photo: TelegramPhotoInput;
			captionHtml: string;
			plain?: boolean;
			silent?: boolean;
			replyTo?: number;
		}): Promise<number> {
			const payload: Record<string, unknown> = {
				chat_id: chat(input.chatId),
				caption: input.captionHtml,
				...(input.plain ? {} : { parse_mode: 'HTML' }),
				...(input.silent ? { disable_notification: true } : {}),
				...replyParameters(input.replyTo),
			};
			if (input.photo.kind === 'url') {
				payload.photo = input.photo.url;
				return messageIdOf(await call('sendPhoto', payload));
			}
			payload.photo = 'attach://photo';
			return messageIdOf(
				await call('sendPhoto', payload, {
					field: 'photo',
					data: input.photo.data,
					fileName: input.photo.fileName,
					mimeType: input.photo.mimeType,
				}),
			);
		},

		async editMessageText(input: {
			chatId: string;
			messageId: number;
			html: string;
			plain?: boolean;
			linkPreview?: LinkPreviewOptions;
		}): Promise<'updated' | 'unchanged'> {
			return unchangedIsFine(() =>
				call('editMessageText', {
					chat_id: chat(input.chatId),
					message_id: input.messageId,
					text: input.html,
					...(input.plain ? {} : { parse_mode: 'HTML' }),
					...(input.linkPreview ? { link_preview_options: input.linkPreview } : {}),
				}),
			);
		},

		async editMessageCaption(input: {
			chatId: string;
			messageId: number;
			captionHtml: string;
			plain?: boolean;
		}): Promise<'updated' | 'unchanged'> {
			return unchangedIsFine(() =>
				call('editMessageCaption', {
					chat_id: chat(input.chatId),
					message_id: input.messageId,
					caption: input.captionHtml,
					...(input.plain ? {} : { parse_mode: 'HTML' }),
				}),
			);
		},

		async editMessageMedia(input: {
			chatId: string;
			messageId: number;
			photo: TelegramPhotoInput;
			captionHtml: string;
			plain?: boolean;
		}): Promise<'updated' | 'unchanged'> {
			const media: Record<string, unknown> = {
				type: 'photo',
				media: input.photo.kind === 'url' ? input.photo.url : 'attach://photo',
				caption: input.captionHtml,
				...(input.plain ? {} : { parse_mode: 'HTML' }),
			};
			const payload = { chat_id: chat(input.chatId), message_id: input.messageId, media };
			return unchangedIsFine(() =>
				input.photo.kind === 'url'
					? call('editMessageMedia', payload)
					: call('editMessageMedia', payload, {
							field: 'photo',
							data: input.photo.data,
							fileName: input.photo.fileName,
							mimeType: input.photo.mimeType,
						}),
			);
		},

		/** True when the message is gone, including when it already was. */
		async deleteMessage(input: { chatId: string; messageId: number }): Promise<boolean> {
			try {
				await call('deleteMessage', { chat_id: chat(input.chatId), message_id: input.messageId });
				return true;
			} catch (error) {
				if (error instanceof TelegramApiError && error.kind === 'deleted') return true;
				throw error;
			}
		},
	};
}

export type TelegramApi = ReturnType<typeof createTelegramApi>;

async function unchangedIsFine(run: () => Promise<unknown>): Promise<'updated' | 'unchanged'> {
	try {
		await run();
		return 'updated';
	} catch (error) {
		if (error instanceof TelegramApiError && error.kind === 'unchanged') return 'unchanged';
		throw error;
	}
}

function replyParameters(replyTo: number | undefined): Record<string, unknown> {
	if (!replyTo) return {};
	return { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
}

function messageIdOf(result: unknown): number {
	const id = isRecord(result) ? result.message_id : undefined;
	if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
		throw new TelegramApiError('Telegram did not return a message id.', 'other');
	}
	return id;
}

interface Upload {
	field: string;
	data: ArrayBuffer;
	fileName: string;
	mimeType: string;
}

function jsonRequest(payload: Record<string, unknown>): { headers: Record<string, string>; body: string } {
	return {
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify(payload),
	};
}

/**
 * multipart/form-data by hand. `requestUrl` takes an ArrayBuffer body, and
 * FormData is not something it can send on every platform.
 */
export function multipartRequest(
	payload: Record<string, unknown>,
	upload: Upload,
	boundary = `----oddava${randomHex()}`,
): { headers: Record<string, string>; bodyBytes: ArrayBuffer } {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const [name, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		chunks.push(
			encoder.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`,
			),
		);
	}
	const safeName = upload.fileName.replace(/["\r\n\\]/g, '_') || 'photo';
	chunks.push(
		encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="${upload.field}"; filename="${safeName}"\r\nContent-Type: ${upload.mimeType}\r\n\r\n`,
		),
	);
	chunks.push(new Uint8Array(upload.data));
	chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return {
		headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Accept: 'application/json' },
		bodyBytes: body.buffer as ArrayBuffer,
	};
}

function randomHex(): string {
	let value = '';
	for (let i = 0; i < 16; i += 1) value += Math.floor(Math.random() * 16).toString(16);
	return value;
}

/** Turn a Bot API failure into an error a person can act on. */
export function classifyTelegramFailure(status: number, body: unknown, token?: string): TelegramApiError {
	const description = isRecord(body) && typeof body.description === 'string' ? body.description : '';
	const parameters = isRecord(body) && isRecord(body.parameters) ? body.parameters : undefined;
	const retryAfter =
		parameters && typeof parameters.retry_after === 'number' ? parameters.retry_after : undefined;
	const lower = description.toLowerCase();
	const make = (message: string, kind: TelegramErrorKind): TelegramApiError =>
		new TelegramApiError(redact(message, token), kind, status, redact(description, token), retryAfter);

	if (lower.includes('message is not modified')) {
		return make('The Telegram post already matches this note.', 'unchanged');
	}
	if (
		lower.includes('message to edit not found') ||
		lower.includes('message to be edited not found') ||
		lower.includes('message_id_invalid') ||
		lower.includes('message to delete not found')
	) {
		return make('That Telegram post was deleted. Post to Telegram can send a new one.', 'deleted');
	}
	if (lower.includes("message can't be edited") || lower.includes("message can't be deleted")) {
		return make(
			'Telegram no longer lets the bot change that message. Delete it in Telegram, or post a new one.',
			'not-editable',
		);
	}
	if (status === 401 || lower.includes('unauthorized')) {
		return make('The Telegram bot token was rejected. Check the token in settings.', 'auth');
	}
	if (lower.includes('chat not found') || lower.includes('chat_id is empty')) {
		return make(
			'Telegram could not find that channel. Check the channel id, and make sure the bot is an admin.',
			'chat',
		);
	}
	if (
		status === 403 ||
		lower.includes('not enough rights') ||
		lower.includes('need administrator') ||
		lower.includes('bot is not a member') ||
		lower.includes('have no rights') ||
		lower.includes('bot was kicked')
	) {
		return make(
			'Telegram refused the post. Add the bot as an admin of the channel, with permission to post, edit, and delete messages.',
			'rights',
		);
	}
	if (status === 429 || lower.includes('too many requests')) {
		const wait = retryAfter ? ` Try again in ${retryAfter} seconds.` : ' Wait a moment and try again.';
		return make(`Telegram is rate limiting posts.${wait}`, 'rate');
	}
	if (lower.includes("can't parse entities") || lower.includes('unsupported start tag') || lower.includes('can\'t find end tag')) {
		return make(`Telegram could not read the formatting. ${description}`, 'parse');
	}
	if (lower.includes('message is too long') || lower.includes('caption is too long') || lower.includes('message_too_long')) {
		return make('The post is longer than Telegram allows.', 'too-long');
	}
	if (
		status === 413 ||
		lower.includes('photo') ||
		lower.includes('image_process_failed') ||
		lower.includes('wrong file identifier') ||
		lower.includes('failed to get http url content') ||
		lower.includes('wrong type of the web page content') ||
		lower.includes('file is too big') ||
		lower.includes('wrong remote file')
	) {
		return make(`Telegram could not use the cover image. ${description || `HTTP ${status}.`}`.trim(), 'photo');
	}
	if (description) return make(`Telegram refused the post. ${description}`, 'other');
	return make(`Telegram returned HTTP ${status}.`, 'other');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
