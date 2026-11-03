import {
	TelegramApiError,
	type TelegramApi,
	type TelegramPhotoInput,
} from './telegram-api';
import {
	coverChanged,
	type TelegramCover,
	type TelegramPart,
	type TelegramPostDraft,
	type TelegramRecord,
} from './telegram';

/**
 * Runs a post against the Bot API. Pure apart from the injected API and
 * photo loader, so the whole flow is tested with a fake Telegram.
 *
 * Every function returns the record that matches what is on the channel now,
 * even after a failure part-way through, so the note never forgets a message
 * that was sent.
 */

export interface TelegramPostEnv {
	api: Pick<
		TelegramApi,
		'sendMessage' | 'sendPhoto' | 'pinChatMessage' | 'editMessageText' | 'editMessageCaption' | 'editMessageMedia' | 'deleteMessage'
	>;
	chatId: string;
	/** Send without a notification sound. Messages after the first are always silent. */
	silent: boolean;
	/** Pin the first message of a new post. Never used by edits. */
	pin?: boolean;
	loadPhoto: (cover: TelegramCover) => Promise<TelegramPhotoInput>;
}

export interface TelegramPostResult {
	ok: boolean;
	/** What the note should store. Null when nothing on the channel changed. */
	record: TelegramRecord | null;
	sent: number;
	edited: number;
	deleted: number;
	/** The channel already matched. Nothing was sent. */
	unchanged: boolean;
	/** The cover photo was refused and the post went out as text. */
	droppedPhoto: boolean;
	/** The first message was pinned. */
	pinned?: boolean;
	error?: Error;
	warnings: string[];
}

function result(partial: Partial<TelegramPostResult>): TelegramPostResult {
	return {
		ok: false,
		record: null,
		sent: 0,
		edited: 0,
		deleted: 0,
		unchanged: false,
		droppedPhoto: false,
		warnings: [],
		...partial,
	};
}

/** Send the whole post as new messages. */
export async function sendNewPost(env: TelegramPostEnv, draft: TelegramPostDraft): Promise<TelegramPostResult> {
	const warnings: string[] = [];
	let parts = draft.parts;
	let droppedPhoto = false;
	const ids: number[] = [];
	const hashes: string[] = [];
	let pinned = false;
	const record = (): TelegramRecord | null =>
		ids.length > 0
			? { messageIds: [...ids], hashes: [...hashes], media: parts[0]?.kind === 'photo' ? 'photo' : undefined }
			: null;

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index] as TelegramPart;
		try {
			const id = await sendPart(env, draft, part, {
				silent: env.silent || index > 0,
				replyTo: undefined,
				warnings,
			});
			ids.push(id);
			hashes.push(part.hash);
			// Pinned once, right after the first message, so a post that stops
			// part-way is still pinned. A failure is reported, not retried.
			if (index === 0 && env.pin) pinned = await pinFirst(env, id, warnings);
		} catch (error) {
			if (index === 0 && part.kind === 'photo' && isPhotoProblem(error) && draft.textOnly) {
				warnings.push(`${errorMessage(error)} Posted without the cover image.`);
				parts = draft.textOnly;
				droppedPhoto = true;
				index = -1;
				continue;
			}
			return result({ record: record(), sent: ids.length, droppedPhoto, pinned, error: asError(error), warnings });
		}
	}
	return result({ ok: true, record: record(), sent: ids.length, droppedPhoto, pinned, warnings });
}

/** One attempt. The post already went out, so a failure only adds a warning. */
async function pinFirst(env: TelegramPostEnv, messageId: number, warnings: string[]): Promise<boolean> {
	try {
		await env.api.pinChatMessage({ chatId: env.chatId, messageId });
		return true;
	} catch (error) {
		// Prefer Telegram's own description (e.g. "not enough rights to pin a message")
		// over the generic wording, which talks about posting rather than pinning.
		const description =
			error instanceof TelegramApiError ? error.description.replace(/^Bad Request:\s*/i, '').trim() : '';
		const reason = description ? `Telegram said: ${description}.` : errorMessage(error);
		warnings.push(
			`The post was sent, but it could not be pinned. ${reason ? `${reason} ` : ''}Give the bot the "Pin messages" admin right in the channel, or pin it by hand.`,
		);
		return false;
	}
}

/**
 * Bring the existing post in line with the note. Changed messages are
 * edited, extra messages are deleted, and when the note grew (and
 * `allowGrowth` is set) new messages are sent as replies to the post.
 */
export async function updatePost(
	env: TelegramPostEnv,
	draft: TelegramPostDraft,
	options: { allowGrowth: boolean },
): Promise<TelegramPostResult> {
	const existing = draft.existing;
	const change = draft.change;
	if (!existing || change.kind === 'new') {
		return result({ error: new Error('This note has no Telegram post to update yet.') });
	}
	if (change.kind === 'incompatible') return result({ error: new Error(change.reason) });
	if (change.kind === 'grows' && !options.allowGrowth) {
		return result({
			error: new Error(`The post needs ${change.to} messages now and has ${change.from}.`),
		});
	}

	const warnings: string[] = [];
	const ids = [...existing.messageIds];
	const hashes = existing.messageIds.map((_, index) => existing.hashes[index] ?? '');
	let edited = 0;
	let sent = 0;
	let deleted = 0;
	const record = (): TelegramRecord => ({ messageIds: [...ids], hashes: [...hashes], media: existing.media });
	const parts = draft.updateParts;

	for (let index = 0; index < Math.min(ids.length, parts.length); index += 1) {
		const part = parts[index] as TelegramPart;
		if (hashes[index] === part.hash) continue;
		try {
			const outcome = await editPart(env, draft, ids[index] as number, part, hashes[index], warnings);
			if (outcome === 'updated') edited += 1;
			hashes[index] = part.hash;
		} catch (error) {
			return result({ record: edited > 0 ? record() : null, edited, error: asError(error), warnings });
		}
	}

	for (let index = ids.length; index < parts.length; index += 1) {
		const part = parts[index] as TelegramPart;
		try {
			const id = await sendPart(env, draft, part, {
				silent: true,
				replyTo: ids[ids.length - 1],
				warnings,
			});
			ids.push(id);
			hashes.push(part.hash);
			sent += 1;
		} catch (error) {
			return result({ record: record(), edited, sent, error: asError(error), warnings });
		}
	}

	if (ids.length > parts.length) {
		const extra = ids.splice(parts.length);
		hashes.splice(parts.length);
		const left = await deleteMessages(env, extra, warnings, { messageId: ids[0] as number });
		deleted = extra.length - left.length;
	}

	const changed = edited > 0 || sent > 0 || deleted > 0 || hashes.some((hash, index) => hash !== existing.hashes[index]);
	return result({
		ok: true,
		record: changed || ids.length !== existing.messageIds.length ? record() : null,
		edited,
		sent,
		deleted,
		unchanged: edited === 0 && sent === 0 && deleted === 0,
		warnings,
	});
}

/** Send the post again in order, then delete the old messages. */
export async function replacePost(env: TelegramPostEnv, draft: TelegramPostDraft): Promise<TelegramPostResult> {
	const old = draft.existing?.messageIds ?? [];
	const fresh = await sendNewPost(env, draft);
	if (!fresh.ok) {
		// The old post is still the one the note tracks. Take back the part of
		// the new one that went out, so the channel does not show it twice.
		const warnings = [...fresh.warnings];
		const partial = fresh.record?.messageIds ?? [];
		if (partial.length > 0) {
			const left = await deleteMessages(env, partial, [], old[0] ? { messageId: old[0] } : undefined);
			if (left.length > 0) {
				warnings.push(
					`The new post stopped part-way. Delete ${left.length === 1 ? `message ${left[0]}` : `messages ${left.join(', ')}`} in Telegram; the note still points to the old post.`,
				);
			}
		}
		return { ...fresh, record: null, sent: 0, warnings };
	}
	const warnings = [...fresh.warnings];
	const newFirst = fresh.record?.messageIds[0];
	const left = await deleteMessages(
		env,
		old,
		warnings,
		newFirst
			? { messageId: newFirst, photoIds: draft.existing?.media === 'photo' && old[0] ? [old[0]] : [] }
			: undefined,
	);
	return { ...fresh, deleted: old.length - left.length, warnings };
}

/**
 * Delete messages. Telegram only lets a bot delete its messages for a while;
 * one it will not delete is edited into a link to `pointTo` instead, so the
 * channel does not keep showing old text. Returns the ids still showing it.
 */
async function deleteMessages(
	env: TelegramPostEnv,
	ids: number[],
	warnings: string[],
	pointTo?: { messageId: number; photoIds?: number[] },
): Promise<number[]> {
	const left: number[] = [];
	const pointed: number[] = [];
	let reason = '';
	const link = pointTo ? telegramMessageLink(env.chatId, pointTo.messageId) : null;
	for (const messageId of ids) {
		try {
			await env.api.deleteMessage({ chatId: env.chatId, messageId });
			continue;
		} catch (error) {
			reason ||= errorMessage(error);
		}
		if (link && (await pointToPost(env, messageId, link, pointTo?.photoIds?.includes(messageId) === true))) {
			pointed.push(messageId);
		} else {
			left.push(messageId);
		}
	}
	const name = (list: number[]): string => (list.length === 1 ? `message ${list[0]}` : `messages ${list.join(', ')}`);
	if (pointed.length > 0) {
		warnings.push(
			`Telegram would not let the bot delete the old ${name(pointed)}, so ${pointed.length === 1 ? 'it now links' : 'they now link'} to the current post. Delete ${pointed.length === 1 ? 'it' : 'them'} in Telegram if you like.`,
		);
	}
	if (left.length > 0) {
		warnings.push(
			`Could not delete the old ${name(left)}. Delete ${left.length === 1 ? 'it' : 'them'} in Telegram. ${reason}`.trim(),
		);
	}
	return left;
}

const POINTER_TEXT = 'This post was updated. Read the current version.';

async function pointToPost(env: TelegramPostEnv, messageId: number, link: string, photo: boolean): Promise<boolean> {
	const html = `<a href="${link}">${POINTER_TEXT}</a>`;
	try {
		if (photo) await env.api.editMessageCaption({ chatId: env.chatId, messageId, captionHtml: html });
		else await env.api.editMessageText({ chatId: env.chatId, messageId, html, linkPreview: { is_disabled: true } });
		return true;
	} catch {
		return false;
	}
}

/** `https://t.me/<channel>/<id>`, or the `t.me/c/` form for a numeric id. */
export function telegramMessageLink(chatId: string, messageId: number): string | null {
	const trimmed = chatId.trim();
	if (trimmed.startsWith('@')) return `https://t.me/${trimmed.slice(1)}/${messageId}`;
	const internal = trimmed.match(/^-100(\d+)$/);
	if (internal) return `https://t.me/c/${internal[1]}/${messageId}`;
	return null;
}

async function sendPart(
	env: TelegramPostEnv,
	draft: TelegramPostDraft,
	part: TelegramPart,
	options: { silent: boolean; replyTo: number | undefined; warnings: string[] },
): Promise<number> {
	if (part.kind === 'photo') {
		if (!draft.cover) throw new Error('The cover image is missing.');
		const photo = await loadPhoto(env, draft.cover);
		return withPlainFallback(options.warnings, (plain) =>
			env.api.sendPhoto({
				chatId: env.chatId,
				photo,
				captionHtml: plain ? part.text.plain : part.text.html,
				plain,
				silent: options.silent,
				replyTo: options.replyTo,
			}),
		);
	}
	return withPlainFallback(options.warnings, (plain) =>
		env.api.sendMessage({
			chatId: env.chatId,
			html: plain ? part.text.plain : part.text.html,
			plain,
			linkPreview: part.linkPreview,
			silent: options.silent,
			replyTo: options.replyTo,
		}),
	);
}

async function editPart(
	env: TelegramPostEnv,
	draft: TelegramPostDraft,
	messageId: number,
	part: TelegramPart,
	previousHash: string | undefined,
	warnings: string[],
): Promise<'updated' | 'unchanged'> {
	if (part.kind === 'photo') {
		if (!draft.cover) throw new Error('The cover image is missing.');
		if (coverChanged(previousHash, part)) {
			const photo = await loadPhoto(env, draft.cover);
			return withPlainFallback(warnings, (plain) =>
				env.api.editMessageMedia({
					chatId: env.chatId,
					messageId,
					photo,
					captionHtml: plain ? part.text.plain : part.text.html,
					plain,
				}),
			);
		}
		return withPlainFallback(warnings, (plain) =>
			env.api.editMessageCaption({
				chatId: env.chatId,
				messageId,
				captionHtml: plain ? part.text.plain : part.text.html,
				plain,
			}),
		);
	}
	return withPlainFallback(warnings, (plain) =>
		env.api.editMessageText({
			chatId: env.chatId,
			messageId,
			html: plain ? part.text.plain : part.text.html,
			plain,
			linkPreview: part.linkPreview,
		}),
	);
}

/**
 * If Telegram cannot read the formatting, send the same words unformatted
 * rather than nothing. That is a bug in the converter, so say so.
 */
async function withPlainFallback<T>(warnings: string[], run: (plain: boolean) => Promise<T>): Promise<T> {
	try {
		return await run(false);
	} catch (error) {
		if (!(error instanceof TelegramApiError) || error.kind !== 'parse') throw error;
		const value = await run(true);
		const note = 'Telegram could not read part of the formatting, so that message went out as plain text.';
		if (!warnings.includes(note)) warnings.push(note);
		return value;
	}
}

async function loadPhoto(env: TelegramPostEnv, cover: TelegramCover): Promise<TelegramPhotoInput> {
	try {
		return await env.loadPhoto(cover);
	} catch (error) {
		throw new TelegramApiError(`Could not read the cover image ${cover.label}. ${errorMessage(error)}`.trim(), 'photo');
	}
}

function isPhotoProblem(error: unknown): boolean {
	return error instanceof TelegramApiError && (error.kind === 'photo' || error.kind === 'too-long');
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error('Could not reach Telegram.');
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : '';
}
