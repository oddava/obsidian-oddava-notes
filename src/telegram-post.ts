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
		'sendMessage' | 'sendPhoto' | 'editMessageText' | 'editMessageCaption' | 'editMessageMedia' | 'deleteMessage'
	>;
	chatId: string;
	/** Send without a notification sound. Messages after the first are always silent. */
	silent: boolean;
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
		} catch (error) {
			if (index === 0 && part.kind === 'photo' && isPhotoProblem(error) && draft.textOnly) {
				warnings.push(`${errorMessage(error)} Posted without the cover image.`);
				parts = draft.textOnly;
				droppedPhoto = true;
				index = -1;
				continue;
			}
			return result({ record: record(), sent: ids.length, droppedPhoto, error: asError(error), warnings });
		}
	}
	return result({ ok: true, record: record(), sent: ids.length, droppedPhoto, warnings });
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
	const parts = draft.parts;

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
		const left = await deleteMessages(env, extra, warnings);
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
	if (!fresh.ok) return fresh;
	const warnings = [...fresh.warnings];
	const left = await deleteMessages(env, old, warnings);
	return { ...fresh, deleted: old.length - left.length, warnings };
}

async function deleteMessages(env: TelegramPostEnv, ids: number[], warnings: string[]): Promise<number[]> {
	const left: number[] = [];
	let reason = '';
	for (const messageId of ids) {
		try {
			await env.api.deleteMessage({ chatId: env.chatId, messageId });
		} catch (error) {
			left.push(messageId);
			reason ||= errorMessage(error);
		}
	}
	if (left.length > 0) {
		const which = left.length === 1 ? `message ${left[0]}` : `messages ${left.join(', ')}`;
		warnings.push(
			`Could not delete the old ${which}. Delete ${left.length === 1 ? 'it' : 'them'} in Telegram. ${reason}`.trim(),
		);
	}
	return left;
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
