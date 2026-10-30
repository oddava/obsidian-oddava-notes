import { normalizeBaseUrl } from './api';
import { contentFingerprint } from './fingerprint';
import {
	readTelegramFrontmatter,
	splitFrontmatter,
	readFrontmatterScalar,
	upsertFrontmatter,
} from './frontmatter';
import { redact } from './messages';
import { parseApiPath, toApiPath } from './paths';
import type { HttpClient } from './types';

/** Where posts go when settings have no channel yet. */
export const DEFAULT_TELEGRAM_CHANNEL = '@justoddava';

/**
 * Below this much plain text, a flagged note is not posted on publish.
 * A manual post still asks, and Cancel leaves it unsent.
 */
export const NEARLY_EMPTY_CHARS = 40;

export const EXCERPT_MAX_CHARS = 220;

export class TelegramPostDeleted extends Error {
	constructor() {
		super('That Telegram post was deleted. Post to Telegram can send a new one.');
		this.name = 'TelegramPostDeleted';
	}
}

export interface TelegramPostDraft {
	apiPath: string;
	title: string;
	excerpt: string;
	url: string;
	/** Exact words of the post. Telegram bolds the title line. */
	plain: string;
	html: string;
	/** Set when this note already has telegram_message_id. */
	messageId?: number;
	unchanged: boolean;
	warnings: string[];
}

export type TelegramPrepareResult =
	| { ok: true; draft: TelegramPostDraft }
	| { ok: false; reason: string };

/** What a successful publish should do about Telegram. Autosave never posts. */
export type TelegramFollowUp =
	| { kind: 'skip' }
	| { kind: 'too-short'; notice: string }
	| { kind: 'post' }
	| { kind: 'edit'; messageId: number; unchanged: boolean };

const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*#*\s*$/m;
const TOO_SHORT_NOTICE = 'Not posted to Telegram. The note is still too short.';

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
	const withAt = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
	if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(withAt)) return withAt;
	return null;
}

/**
 * Canonical public URL. The site builds `href` as `/notes/` plus the source
 * path without `.md` (`diary/hello.md` → `/notes/diary/hello`). A unique file
 * name also redirects (`/notes/hello`), and `index` is `/notes`.
 */
export function publicNoteUrl(baseUrl: string, apiPath: string): string | null {
	const origin = normalizeBaseUrl(baseUrl);
	if (!origin) return null;
	const parsed = parseApiPath(apiPath);
	if (!parsed.ok) return null;
	const path = parsed.apiPath.replace(/\.md$/i, '');
	if (path === 'index') return `${origin}/notes`;
	return `${origin}/notes/${path}`;
}

/**
 * Manual Publish may post or edit. Publish on save must not: it runs while
 * the note is still being typed. Publish-and-post opens the confirmation
 * modal itself, so it must not also send here.
 */
export function telegramFollowUp(
	source: 'command' | 'autosave' | 'publish-and-post',
	content: string,
	plain: string,
): TelegramFollowUp {
	if (source !== 'command') return { kind: 'skip' };
	const meta = readTelegramFrontmatter(content);
	if (meta.messageId) {
		return {
			kind: 'edit',
			messageId: meta.messageId,
			unchanged: meta.hash === contentFingerprint(plain),
		};
	}
	if (!meta.enabled) return { kind: 'skip' };
	if (plainBody(splitFrontmatter(content).body).length < NEARLY_EMPTY_CHARS) {
		return { kind: 'too-short', notice: TOO_SHORT_NOTICE };
	}
	return { kind: 'post' };
}

export function prepareTelegramPost(input: {
	vaultPath: string;
	syncFolder: string;
	content: string;
	baseUrl: string;
	channel: string;
	publishedRevision?: string;
	fingerprint?: string;
}): TelegramPrepareResult {
	const mapped = toApiPath(input.syncFolder, input.vaultPath);
	if (!mapped.ok) return { ok: false, reason: mapped.reason };

	const channel = normalizeTelegramChannel(input.channel);
	if (!channel) {
		return { ok: false, reason: 'Set a Telegram channel, like @justoddava.' };
	}

	if (!input.publishedRevision) {
		return {
			ok: false,
			reason: 'Publish this note before posting it to Telegram. The post links to the public page.',
		};
	}

	const url = publicNoteUrl(input.baseUrl, mapped.apiPath);
	if (!url) {
		return { ok: false, reason: 'The site URL is not a valid http(s) origin. Use https://oddava.me.' };
	}

	const { title, excerpt } = noteTitleAndExcerpt(input.content, mapped.apiPath);
	const plain = plainPost(title, excerpt, url);
	const meta = readTelegramFrontmatter(input.content);
	const warnings: string[] = [];
	if (plainBody(splitFrontmatter(input.content).body).length < NEARLY_EMPTY_CHARS) {
		warnings.push('This note looks nearly empty. Send it only if that is what you want.');
	}
	if (input.fingerprint && contentFingerprint(input.content) !== input.fingerprint) {
		warnings.push('This device has edits that are not on the site yet. The link opens the published page.');
	}
	if (meta.messageId) {
		warnings.push(
			`Already posted to ${channel} as message ${meta.messageId}. Update that post, or send a new one.`,
		);
	}

	return {
		ok: true,
		draft: {
			apiPath: mapped.apiPath,
			title,
			excerpt,
			url,
			plain,
			html: telegramHtml(title, excerpt, url),
			messageId: meta.messageId,
			unchanged: meta.messageId !== undefined && meta.hash === contentFingerprint(plain),
			warnings,
		},
	};
}

export function plainPost(title: string, excerpt: string, url: string): string {
	const parts = [title];
	if (excerpt) parts.push(excerpt);
	parts.push(url);
	return parts.join('\n\n');
}

export function telegramHtml(title: string, excerpt: string, url: string): string {
	const parts = [`<b>${escapeHtml(title)}</b>`];
	if (excerpt) parts.push(escapeHtml(excerpt));
	parts.push(escapeHtml(url));
	return parts.join('\n\n');
}

export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Write the id (and a hash of the text we sent) into the note the user has now. */
export function withTelegramMessageId(content: string, messageId: number, plain: string): string {
	return upsertFrontmatter(content, {
		telegram_message_id: String(messageId),
		telegram_hash: contentFingerprint(plain),
	});
}

export async function sendTelegramMessage(
	http: HttpClient,
	input: { token: string; chatId: string; html: string },
): Promise<{ messageId: number }> {
	const body = await telegramRequest(http, input.token, 'sendMessage', {
		chat_id: normalizeTelegramChannel(input.chatId),
		text: input.html,
		parse_mode: 'HTML',
	});
	const result = isRecord(body) ? body.result : undefined;
	const messageId = isRecord(result) ? result.message_id : undefined;
	if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
		throw new Error('Telegram did not return a message id.');
	}
	return { messageId };
}

export async function editTelegramMessage(
	http: HttpClient,
	input: { token: string; chatId: string; messageId: number; html: string },
): Promise<'updated' | 'unchanged'> {
	try {
		await telegramRequest(http, input.token, 'editMessageText', {
			chat_id: normalizeTelegramChannel(input.chatId),
			message_id: input.messageId,
			text: input.html,
			parse_mode: 'HTML',
		});
		return 'updated';
	} catch (error) {
		if (error instanceof TelegramUnchanged) return 'unchanged';
		throw error;
	}
}

class TelegramUnchanged extends Error {
	constructor() {
		super('message is not modified');
		this.name = 'TelegramUnchanged';
	}
}

async function telegramRequest(
	http: HttpClient,
	token: string,
	method: 'sendMessage' | 'editMessageText',
	payload: { chat_id: string | null; text: string; parse_mode: 'HTML'; message_id?: number },
): Promise<unknown> {
	const tokenProblem = telegramTokenProblem(token);
	if (tokenProblem) throw new Error(tokenProblem);
	if (!payload.chat_id) throw new Error('Set a Telegram channel, like @justoddava.');

	const trimmed = token.trim();
	const url = `https://api.telegram.org/bot${trimmed}/${method}`;
	let status = 0;
	let body: unknown;
	try {
		const response = await http({
			method: 'POST',
			url,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ ...payload, chat_id: payload.chat_id }),
		});
		status = response.status;
		body = response.body;
	} catch (error) {
		const message = error instanceof Error && error.message ? error.message : 'Could not reach Telegram.';
		throw new Error(redact(message, trimmed));
	}

	if (isRecord(body) && body.ok === true) return body;
	const description = isRecord(body) && typeof body.description === 'string' ? body.description : '';
	if (description.toLowerCase().includes('message is not modified')) {
		throw new TelegramUnchanged();
	}
	if (isDeletedTelegramMessage(description)) {
		throw new TelegramPostDeleted();
	}
	throw new Error(explainTelegramFailure(status, body, trimmed));
}

export function explainTelegramFailure(status: number, body: unknown, token?: string): string {
	const description = isRecord(body) && typeof body.description === 'string' ? body.description : '';
	const lower = description.toLowerCase();
	let message: string;
	if (status === 401 || lower.includes('unauthorized')) {
		message = 'The Telegram bot token was rejected. Check the token in settings.';
	} else if (lower.includes('chat not found') || lower.includes('chat_id is empty')) {
		message =
			'Telegram could not find that channel. Check the channel id, and make sure the bot is an admin.';
	} else if (
		status === 403 ||
		lower.includes('not enough rights') ||
		lower.includes('need administrator') ||
		lower.includes('bot is not a member') ||
		lower.includes('have no rights')
	) {
		message = 'Telegram refused the post. Add the bot as an admin of the channel, with permission to post.';
	} else if (status === 429 || lower.includes('too many requests')) {
		message = 'Telegram is rate limiting posts. Wait a moment and try again.';
	} else if (lower.includes('message is too long')) {
		message = 'The post is longer than Telegram allows.';
	} else if (isDeletedTelegramMessage(description)) {
		message = new TelegramPostDeleted().message;
	} else if (description) {
		message = `Telegram refused the post. ${description}`;
	} else {
		message = `Telegram returned HTTP ${status}.`;
	}
	return redact(message, token);
}

function isDeletedTelegramMessage(description: string): boolean {
	const lower = description.toLowerCase();
	return (
		lower.includes('message to edit not found') ||
		lower.includes('message to be edited not found') ||
		lower.includes('message_id_invalid') ||
		lower.includes("message can't be edited") ||
		lower.includes('message to delete not found')
	);
}

export function noteTitleAndExcerpt(content: string, apiPath: string): { title: string; excerpt: string } {
	const { raw, body } = splitFrontmatter(content);
	const frontmatterTitle = raw ? readFrontmatterScalar(raw, 'title')?.trim() : undefined;
	const leaf = apiPath.split('/').pop()?.replace(/\.md$/i, '') ?? apiPath;
	const title = frontmatterTitle || titleFromBody(body, leaf);
	return { title, excerpt: excerptFromBody(body) };
}

function titleFromBody(body: string, leaf: string): string {
	const heading = body.match(HEADING_PATTERN)?.[1];
	if (heading) {
		const text = stripInline(heading);
		if (text) return text;
	}
	return humanizeSlug(leaf);
}

function excerptFromBody(body: string): string {
	const text = plainParts(body)[0];
	return text ? truncateExcerpt(text) : '';
}

function plainBody(body: string): string {
	return plainParts(body).join(' ');
}

function plainParts(body: string): string[] {
	const parts: string[] = [];
	for (const block of body.split(/\n{2,}/)) {
		const line = block.trim();
		if (!line || line.startsWith('#') || line.startsWith('![') || line.startsWith('```')) continue;
		if (/^<(?:figure|picture|img|video|audio)\b/i.test(line)) continue;
		const text = stripInline(
			line.replace(/^>\s?/gm, '').replace(/^[-*+]\s+/gm, '').replace(/^\d+\.\s+/gm, ''),
		);
		if (text) parts.push(text);
	}
	return parts;
}

function stripInline(value: string): string {
	return value
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[\[[^\]|\n]+\|([^\]\n]+)\]\]/g, '$1')
		.replace(/\[\[([^\]|\n]+)\]\]/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/[*_`~]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function truncateExcerpt(text: string): string {
	if (text.length <= EXCERPT_MAX_CHARS) return text;
	const cut = text.slice(0, EXCERPT_MAX_CHARS);
	const space = cut.lastIndexOf(' ');
	const base = space > 80 ? cut.slice(0, space) : cut;
	return `${base.trimEnd()}…`;
}

function humanizeSlug(value: string): string {
	return value
		.split('-')
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
