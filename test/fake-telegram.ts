import type { HttpClient, HttpRequest, HttpResponse } from '../src/types';

export interface FakeMessage {
	id: number;
	kind: 'text' | 'photo';
	text: string;
	parseMode?: string;
	photo?: string;
	linkPreview?: Record<string, unknown>;
	silent: boolean;
	replyTo?: number;
}

export interface FakeCall {
	method: string;
	payload: Record<string, unknown>;
	request: HttpRequest;
}

/**
 * Just enough Bot API to post, edit, and delete in one channel.
 * `fail` lets a test make the next matching call return an error.
 */
export class FakeTelegram {
	readonly messages = new Map<number, FakeMessage>();
	readonly calls: FakeCall[] = [];
	readonly pins: Array<{ id: number; silent: boolean }> = [];
	private nextId = 100;
	private failures: Array<{
		method: string;
		times: number;
		status: number;
		description: string;
		parameters?: Record<string, unknown>;
		when?: (payload: Record<string, unknown>) => boolean;
	}> = [];

	constructor(readonly token = '123456789:AA-real-token_ok') {}

	fail(
		method: string,
		description: string,
		options: {
			status?: number;
			times?: number;
			parameters?: Record<string, unknown>;
			when?: (payload: Record<string, unknown>) => boolean;
		} = {},
	): void {
		this.failures.push({
			method,
			description,
			status: options.status ?? 400,
			times: options.times ?? 1,
			parameters: options.parameters,
			when: options.when,
		});
	}

	/** Messages on the channel, oldest first. */
	channel(): FakeMessage[] {
		return [...this.messages.values()].sort((a, b) => a.id - b.id);
	}

	methods(): string[] {
		return this.calls.map((call) => call.method);
	}

	readonly http: HttpClient = async (request) => {
		const match = request.url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
		if (!match) return reply(404, { ok: false, description: 'Not Found' });
		const [, token, method = ''] = match;
		const payload = request.bodyBytes ? parseMultipart(request) : (JSON.parse(request.body ?? '{}') as Record<string, unknown>);
		this.calls.push({ method, payload, request });
		if (token !== this.token) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });

		const failure = this.failures.find(
			(entry) => entry.method === method && entry.times > 0 && (!entry.when || entry.when(payload)),
		);
		if (failure) {
			failure.times -= 1;
			return reply(failure.status, {
				ok: false,
				error_code: failure.status,
				description: failure.description,
				...(failure.parameters ? { parameters: failure.parameters } : {}),
			});
		}

		switch (method) {
			case 'sendMessage':
			case 'sendPhoto': {
				const id = this.nextId++;
				const replyParameters = payload.reply_parameters as Record<string, unknown> | undefined;
				const photo = method === 'sendPhoto' ? String(payload.photo) : undefined;
				this.messages.set(id, {
					id,
					kind: method === 'sendPhoto' ? 'photo' : 'text',
					text: String(method === 'sendPhoto' ? (payload.caption ?? '') : payload.text),
					parseMode: payload.parse_mode as string | undefined,
					photo: photo === 'attach://photo' ? `upload:${String(payload.__file ?? '')}` : photo,
					linkPreview: payload.link_preview_options as Record<string, unknown> | undefined,
					silent: payload.disable_notification === true,
					replyTo: typeof replyParameters?.message_id === 'number' ? replyParameters.message_id : undefined,
				});
				return reply(200, { ok: true, result: { message_id: id } });
			}
			case 'editMessageText':
			case 'editMessageCaption':
			case 'editMessageMedia': {
				const message = this.messages.get(Number(payload.message_id));
				if (!message) return reply(400, { ok: false, description: 'Bad Request: message to edit not found' });
				if (method === 'editMessageText' && message.kind !== 'text') {
					return reply(400, { ok: false, description: 'Bad Request: there is no text in the message to edit' });
				}
				if (method !== 'editMessageText' && message.kind !== 'photo') {
					return reply(400, { ok: false, description: 'Bad Request: there is no media in the message to edit' });
				}
				let text: string;
				let photo = message.photo;
				if (method === 'editMessageMedia') {
					const media = (typeof payload.media === 'string' ? JSON.parse(payload.media) : payload.media) as Record<
						string,
						unknown
					>;
					text = String(media.caption ?? '');
					photo = media.media === 'attach://photo' ? `upload:${String(payload.__file ?? '')}` : String(media.media);
				} else {
					text = String(method === 'editMessageText' ? payload.text : payload.caption);
				}
				const preview = payload.link_preview_options as Record<string, unknown> | undefined;
				if (
					text === message.text &&
					photo === message.photo &&
					JSON.stringify(preview ?? message.linkPreview) === JSON.stringify(message.linkPreview)
				) {
					return reply(400, {
						ok: false,
						description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
					});
				}
				message.text = text;
				message.photo = photo;
				if (preview) message.linkPreview = preview;
				return reply(200, { ok: true, result: { message_id: message.id } });
			}
			case 'pinChatMessage': {
				const id = Number(payload.message_id);
				if (!this.messages.has(id)) return reply(400, { ok: false, description: 'Bad Request: message to pin not found' });
				this.pins.push({ id, silent: payload.disable_notification === true });
				return reply(200, { ok: true, result: true });
			}
			case 'deleteMessage': {
				const id = Number(payload.message_id);
				if (!this.messages.has(id)) return reply(400, { ok: false, description: 'Bad Request: message to delete not found' });
				this.messages.delete(id);
				return reply(200, { ok: true, result: true });
			}
			case 'getMe':
				return reply(200, { ok: true, result: { id: 42, is_bot: true, username: 'oddava_bot', first_name: 'Oddava' } });
			case 'getChat':
				return reply(200, { ok: true, result: { id: -100123, type: 'channel', title: 'Just Oddava', username: 'justoddava' } });
			case 'getChatMember':
				return reply(200, {
					ok: true,
					result: {
						status: 'administrator',
						can_post_messages: true,
						can_edit_messages: true,
						can_delete_messages: true,
					},
				});
			default:
				return reply(404, { ok: false, description: 'Not Found: method not found' });
		}
	};
}

function reply(status: number, body: unknown): HttpResponse {
	return { status, headers: {}, body };
}

/** Read text fields of a multipart body. The file part is noted as `__file`. */
export function parseMultipart(request: HttpRequest): Record<string, unknown> {
	const boundary = request.headers['Content-Type']?.match(/boundary=(.+)$/)?.[1];
	if (!boundary || !request.bodyBytes) return {};
	// One char per byte, so byte offsets survive. (WHATWG 'latin1' is really windows-1252.)
	let text = '';
	for (const byte of new Uint8Array(request.bodyBytes)) text += String.fromCharCode(byte);
	const fields: Record<string, unknown> = {};
	for (const section of text.split(`--${boundary}`)) {
		const header = section.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/);
		if (!header) continue;
		const [, name = '', filename] = header;
		const value = section.slice(section.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
		if (filename) {
			fields.__file = `${filename}:${value.length}`;
			continue;
		}
		const decoded = new TextDecoder().decode(Uint8Array.from(value, (char) => char.charCodeAt(0)));
		fields[name] = /^[[{]/.test(decoded) ? (JSON.parse(decoded) as unknown) : /^-?\d+$/.test(decoded) && name !== 'chat_id' ? Number(decoded) : decoded;
	}
	return fields;
}
