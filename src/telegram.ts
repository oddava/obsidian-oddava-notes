import { normalizeBaseUrl } from './api';
import { contentFingerprint } from './fingerprint';
import {
	readFrontmatterScalar,
	readTelegramFrontmatter,
	splitFrontmatter,
	upsertFrontmatter,
} from './frontmatter';
import { parseApiPath, toApiPath } from './paths';
import {
	normalizeTelegramChannel,
	type LinkPreviewOptions,
} from './telegram-api';
import {
	markdownToBlocks,
	packBlocks,
	renderRuns,
	runsToPlain,
	splitRuns,
	visibleLength,
	TELEGRAM_CAPTION_LIMIT,
	TELEGRAM_TEXT_LIMIT,
	type Block,
	type FormatContext,
	type RenderedText,
} from './telegram-format';

export { normalizeTelegramChannel, telegramTokenProblem } from './telegram-api';

/** Where posts go when settings have no channel yet. */
export const DEFAULT_TELEGRAM_CHANNEL = '@justoddava';

/**
 * Below this much plain text, a flagged note is not posted on publish.
 * A manual post still asks, and Cancel leaves it unsent.
 */
export const NEARLY_EMPTY_CHARS = 40;

/** Summary posts: the first paragraph, cut at a word near this length. */
export const EXCERPT_MAX_CHARS = 280;

/** A summary keeps adding blocks until it has at least this much text… */
export const SUMMARY_MIN_CHARS = 160;
/** …and never more than this. The page has the rest. */
export const SUMMARY_MAX_CHARS = 600;

/** Telegram's upload limit for photos. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Formats `sendPhoto` accepts. GIF and SVG are not photos to Telegram. */
export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

export type TelegramFormat = 'full' | 'summary';
export const TELEGRAM_FORMATS: Record<TelegramFormat, string> = {
	full: 'Full note',
	summary: 'Summary and link',
};

export type TelegramLinkPreview = 'large-below' | 'large-above' | 'small-below' | 'small-above' | 'off';
export const TELEGRAM_LINK_PREVIEWS: Record<TelegramLinkPreview, string> = {
	'large-below': 'Large card below the text',
	'large-above': 'Large card above the text',
	'small-below': 'Small card below the text',
	'small-above': 'Small card above the text',
	off: 'No link preview',
};

export function telegramFormat(value: unknown): TelegramFormat | undefined {
	return value === 'full' || value === 'summary' ? value : undefined;
}

export function telegramLinkPreview(value: unknown): TelegramLinkPreview | undefined {
	if (typeof value !== 'string') return undefined;
	const lower = value.trim().toLowerCase();
	if (lower in TELEGRAM_LINK_PREVIEWS) return lower as TelegramLinkPreview;
	if (lower === 'false' || lower === 'none' || lower === 'no') return 'off';
	if (lower === 'true' || lower === 'large' || lower === 'yes') return 'large-below';
	if (lower === 'small') return 'small-below';
	if (lower === 'above') return 'large-above';
	return undefined;
}

/** Where the cover photo comes from. Vault files are read and uploaded on send. */
export type TelegramCover =
	| { kind: 'url'; url: string; label: string }
	| { kind: 'vault'; path: string; label: string; size: number; mtime: number };

/** One Telegram message of a post. */
export interface TelegramPart {
	kind: 'text' | 'photo';
	/** Message text, or the photo caption. */
	text: RenderedText;
	/** Text messages only. */
	linkPreview?: LinkPreviewOptions;
	/**
	 * What was sent, for deciding whether an edit is needed. A photo part's
	 * hash is the cover's fingerprint followed by the caption's. Links to
	 * other notes are left out: two devices can disagree about which notes
	 * are published, and must not take turns rewriting the post.
	 */
	hash: string;
}

/** What the note remembers about its channel post. */
export interface TelegramRecord {
	messageIds: number[];
	media?: 'photo';
	hashes: string[];
}

/** How the post on the channel compares with the note now. */
export type TelegramLayoutChange =
	| { kind: 'new' }
	| { kind: 'same'; changed: number[] }
	| { kind: 'grows'; from: number; to: number; changed: number[] }
	| { kind: 'shrinks'; from: number; to: number; changed: number[] }
	| { kind: 'incompatible'; reason: string };

export interface TelegramPostDraft {
	apiPath: string;
	title: string;
	url: string;
	channel: string;
	format: TelegramFormat;
	linkPreview: TelegramLinkPreview;
	parts: TelegramPart[];
	/** The same post without the cover photo, for when Telegram refuses the image. */
	textOnly: TelegramPart[] | null;
	/**
	 * What Update edits the existing post into. A post that went out as text
	 * stays text, even if the note has a cover image now (or Telegram refused
	 * it): Telegram cannot add a photo to a text message. Replace sends `parts`.
	 */
	updateParts: TelegramPart[];
	cover?: TelegramCover;
	/** Set when this note already has a channel post. */
	existing?: TelegramRecord;
	change: TelegramLayoutChange;
	/** True when the channel post already matches, message for message. */
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
	| { kind: 'edit'; unchanged: boolean }
	| { kind: 'confirm'; notice: string };

const HEADING_PATTERN = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/m;
const TOO_SHORT_NOTICE = 'Not posted to Telegram. The note is still too short.';

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
 *
 * An edit that would add messages, or swap a photo post for a text post, is
 * not done silently: new messages land at the bottom of the channel, so the
 * person chooses in the Post to Telegram dialog.
 */
export function telegramFollowUp(
	source: 'command' | 'autosave' | 'publish-and-post',
	content: string,
	draft: TelegramPostDraft | null,
): TelegramFollowUp {
	if (source !== 'command') return { kind: 'skip' };
	const meta = readTelegramFrontmatter(content);
	if (meta.messageIds.length > 0) {
		if (!draft) return { kind: 'skip' };
		const change = draft.change;
		if (change.kind === 'same') return { kind: 'edit', unchanged: change.changed.length === 0 };
		if (change.kind === 'shrinks') return { kind: 'edit', unchanged: false };
		if (change.kind === 'grows') {
			return {
				kind: 'confirm',
				notice: `The Telegram post needs ${change.to} messages now and has ${change.from}. Run Post to Telegram to update or replace it.`,
			};
		}
		if (change.kind === 'incompatible') {
			return { kind: 'confirm', notice: `${change.reason} Run Post to Telegram to replace the post.` };
		}
		return { kind: 'skip' };
	}
	if (!meta.enabled) return { kind: 'skip' };
	if (plainBody(splitFrontmatter(content).body).length < NEARLY_EMPTY_CHARS) {
		return { kind: 'too-short', notice: TOO_SHORT_NOTICE };
	}
	return { kind: 'post' };
}

export interface PrepareTelegramInput {
	vaultPath: string;
	syncFolder: string;
	content: string;
	baseUrl: string;
	channel: string;
	publishedRevision?: string;
	fingerprint?: string;
	/** Setting. `telegram_format` in the note wins. */
	format?: TelegramFormat;
	/** Setting. `telegram_preview` in the note wins. */
	linkPreview?: TelegramLinkPreview;
	/** Resolved cover photo, if any. */
	cover?: TelegramCover | null;
	/** Problems found while resolving the cover. */
	coverWarnings?: string[];
	/** Maps links to other notes onto their public pages. */
	resolveNote?: FormatContext['resolveNote'];
}

export function prepareTelegramPost(input: PrepareTelegramInput): TelegramPrepareResult {
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

	const meta = readTelegramFrontmatter(input.content);
	const format = telegramFormat(meta.format) ?? input.format ?? 'full';
	const linkPreview = telegramLinkPreview(meta.preview) ?? input.linkPreview ?? 'large-below';
	const cover = input.cover ?? undefined;
	const { title } = noteTitleAndExcerpt(input.content, mapped.apiPath);
	const blocks =
		format === 'full'
			? fullBlocks(input.content, title, url, { resolveNote: input.resolveNote })
			: summaryBlocks(input.content, title, url, { resolveNote: input.resolveNote });

	const parts = buildParts(blocks, cover, url, linkPreview);
	const textOnly = cover ? buildParts(blocks, undefined, url, linkPreview) : null;
	const existing: TelegramRecord | undefined =
		meta.messageIds.length > 0
			? { messageIds: meta.messageIds, media: meta.media, hashes: meta.hashes }
			: undefined;
	const keepText = existing !== undefined && existing.media !== 'photo' && textOnly !== null;
	const updateParts = keepText ? textOnly : parts;
	const change = compareLayout(existing, updateParts);

	const warnings: string[] = [...(input.coverWarnings ?? [])];
	if (plainBody(splitFrontmatter(input.content).body).length < NEARLY_EMPTY_CHARS) {
		warnings.push('This note looks nearly empty. Send it only if that is what you want.');
	}
	if (input.fingerprint && contentFingerprint(input.content) !== input.fingerprint) {
		warnings.push('This device has edits that are not on the site yet. The link opens the published page.');
	}
	if (existing) {
		const count = existing.messageIds.length;
		const what = count === 1 ? `message ${existing.messageIds[0]}` : `${count} messages`;
		warnings.push(`Already posted to ${channel} as ${what}. Update that post, replace it, or send a new one.`);
		if (change.kind === 'grows') {
			const extra = change.to - change.from;
			warnings.push(
				`The note is longer now. Update adds ${extra === 1 ? 'a message' : `${extra} messages`} at the end of the channel, as a reply to the post. Replace deletes the old post and sends it again in order.`,
			);
		} else if (change.kind === 'shrinks') {
			const extra = change.from - change.to;
			warnings.push(`The note is shorter now. Update deletes the last ${extra === 1 ? 'message' : `${extra} messages`} of the post.`);
		} else if (change.kind === 'incompatible') {
			warnings.push(`${change.reason} Replace the post or send a new one.`);
		}
		if (keepText && cover) {
			warnings.push(
				`The post on Telegram is text. Update keeps it that way; Replace sends it again with ${cover.label} as the photo.`,
			);
		}
	}

	return {
		ok: true,
		draft: {
			apiPath: mapped.apiPath,
			title,
			url,
			channel,
			format,
			linkPreview,
			parts,
			textOnly,
			updateParts,
			cover,
			existing,
			change,
			unchanged: change.kind === 'same' && change.changed.length === 0,
			warnings,
		},
	};
}

/** Title in bold, the whole note, then a link to the page. */
export function fullBlocks(content: string, title: string, url: string, context: FormatContext = {}): Block[] {
	const { body } = splitFrontmatter(content);
	const blocks = markdownToBlocks(body, context);
	const first = blocks[0];
	if (first?.kind === 'heading' && sameText(runsToPlain(first.runs), title)) blocks.shift();
	return [titleBlock(title), ...blocks, footerBlock(url)];
}

/**
 * Title in bold, the opening of the note with its formatting, then a link.
 * Blocks are added until there is enough to read (a one-line photo caption
 * is not a summary), and the last one is cut short if it runs long. Lists
 * stay lists. Code, tables, and rules are left for the page.
 */
export function summaryBlocks(content: string, title: string, url: string, context: FormatContext = {}): Block[] {
	const { body } = splitFrontmatter(content);
	const source = markdownToBlocks(body, context);
	const first = source[0];
	if (first?.kind === 'heading' && sameText(runsToPlain(first.runs), title)) source.shift();

	const picked: Block[] = [];
	let total = 0;
	for (const block of source) {
		if (block.kind === 'code' || block.kind === 'table' || block.kind === 'rule') continue;
		if (total >= SUMMARY_MIN_CHARS) break;
		const length = visibleLength(block.runs);
		const room = SUMMARY_MAX_CHARS - total;
		if (length > room) {
			const [head] = splitRuns(block.runs, room - 1, block.kind === 'list' || block.kind === 'quote');
			if (head.length > 0) picked.push({ kind: block.kind, runs: [...head, { text: '…', marks: [] }] });
			total = SUMMARY_MAX_CHARS;
			break;
		}
		picked.push(block);
		total += length;
	}
	// A heading with nothing after it says nothing.
	while (picked[picked.length - 1]?.kind === 'heading') picked.pop();
	return [titleBlock(title), ...picked, footerBlock(url)];
}

function titleBlock(title: string): Block {
	return { kind: 'title', runs: [{ text: title, marks: [{ type: 'b' }] }] };
}

function footerBlock(url: string): Block {
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		// Keep the URL as the label.
	}
	return { kind: 'footer', runs: [{ text: `Read on ${host}`, marks: [{ type: 'a', href: url }] }] };
}

/**
 * Split blocks into messages and attach the photo and link preview.
 * With a cover, the first message is the photo and its caption holds as much
 * of the post as 1024 characters allow. The page's link preview goes on the
 * first message, so it heads the post and stays put when the post grows or
 * shrinks. It is left off when a cover photo is sent, so the post does not
 * show the same picture twice.
 */
export function buildParts(
	blocks: Block[],
	cover: TelegramCover | undefined,
	url: string,
	linkPreview: TelegramLinkPreview,
): TelegramPart[] {
	const messages = packBlocks(blocks, (index) =>
		index === 0 && cover ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT,
	);
	const parts: TelegramPart[] = [];
	messages.forEach((runs, index) => {
		const text = renderRuns(runs);
		if (index === 0 && cover) {
			parts.push({ kind: 'photo', text, hash: coverFingerprint(cover) + contentFingerprint(text.stableHtml) });
			return;
		}
		// The card rides on the first message. It never moves when the post
		// grows or shrinks, so no edit has to change only the preview.
		const preview: LinkPreviewOptions =
			index === 0 && !cover ? linkPreviewOptions(linkPreview, url) : { is_disabled: true };
		parts.push({ kind: 'text', text, linkPreview: preview, hash: textFingerprint(text.stableHtml, preview) });
	});
	if (parts.length === 0 && cover) {
		const text = renderRuns([]);
		parts.push({ kind: 'photo', text, hash: coverFingerprint(cover) + contentFingerprint('') });
	}
	return parts;
}

export function linkPreviewOptions(setting: TelegramLinkPreview, url: string): LinkPreviewOptions {
	switch (setting) {
		case 'off':
			return { is_disabled: true };
		case 'large-above':
			return { url, prefer_large_media: true, show_above_text: true };
		case 'small-below':
			return { url, prefer_small_media: true };
		case 'small-above':
			return { url, prefer_small_media: true, show_above_text: true };
		default:
			return { url, prefer_large_media: true };
	}
}

function textFingerprint(html: string, preview: LinkPreviewOptions): string {
	return contentFingerprint(`${html}\u0001${JSON.stringify(preview)}`);
}

export function coverFingerprint(cover: TelegramCover): string {
	return contentFingerprint(
		// Path and size, not mtime: devices that sync the vault see different
		// mtimes for the same file, and would re-upload the photo for nothing.
		cover.kind === 'url' ? `url:${cover.url}` : `vault:${cover.path}:${cover.size}`,
	);
}

/** True when a photo part's image (not its caption) differs from what was sent. */
export function coverChanged(previousHash: string | undefined, part: TelegramPart): boolean {
	if (part.kind !== 'photo') return false;
	return !previousHash || previousHash.slice(0, 8) !== part.hash.slice(0, 8);
}

export function compareLayout(existing: TelegramRecord | undefined, parts: TelegramPart[]): TelegramLayoutChange {
	if (!existing || existing.messageIds.length === 0) return { kind: 'new' };
	const hadPhoto = existing.media === 'photo';
	const hasPhoto = parts[0]?.kind === 'photo';
	if (hadPhoto && !hasPhoto) {
		return {
			kind: 'incompatible',
			reason: 'The post on Telegram starts with a photo, and this note has no cover image now. Telegram cannot turn a photo message into text.',
		};
	}
	if (!hadPhoto && hasPhoto) {
		return {
			kind: 'incompatible',
			reason: 'This note has a cover image now, and the post on Telegram is text. Telegram cannot add a photo to a text message.',
		};
	}
	const from = existing.messageIds.length;
	const to = parts.length;
	const changed: number[] = [];
	for (let index = 0; index < Math.min(from, to); index += 1) {
		if (existing.hashes[index] !== parts[index]?.hash) changed.push(index);
	}
	if (to > from) return { kind: 'grows', from, to, changed };
	if (to < from) return { kind: 'shrinks', from, to, changed };
	return { kind: 'same', changed };
}

/** Write the record into the note the user has now. Other keys stay put. */
export function withTelegramRecord(content: string, record: TelegramRecord): string {
	if (record.messageIds.length === 0) {
		return upsertFrontmatter(content, {
			telegram_message_id: null,
			telegram_message_ids: null,
			telegram_media: null,
			telegram_hash: null,
		});
	}
	return upsertFrontmatter(content, {
		telegram_message_id: String(record.messageIds[0]),
		telegram_message_ids: record.messageIds.length > 1 ? record.messageIds.join(',') : null,
		telegram_media: record.media === 'photo' ? 'photo' : null,
		// Quoted: a hash such as 12e45678 would otherwise read as a YAML number.
		telegram_hash: `"${record.hashes.join(',')}"`,
	});
}

/**
 * Cover photo candidates in order: `telegram_image`, `cover`, `image`, and
 * `banner` in the frontmatter, then images embedded in the body. Each is a
 * URL, a vault path, or a wikilink target. `telegram_image: false` turns the
 * photo off for that note.
 */
export function coverCandidates(content: string): {
	disabled: boolean;
	/** `telegram_image`, which is used even when cover photos are off in settings. */
	explicit?: string;
	candidates: string[];
} {
	const { raw, body } = splitFrontmatter(content);
	const candidates: string[] = [];
	let explicitRef: string | undefined;
	if (raw !== null) {
		const explicit = readFrontmatterScalar(raw, 'telegram_image')?.trim();
		if (explicit && /^(false|no|none|off)$/i.test(explicit)) return { disabled: true, candidates: [] };
		explicitRef = explicit ? cleanImageRef(explicit) || undefined : undefined;
		for (const key of ['telegram_image', 'cover', 'image', 'banner']) {
			const value = readFrontmatterScalar(raw, key);
			const ref = value ? cleanImageRef(value) : '';
			if (ref) candidates.push(ref);
		}
	}
	const withoutCode = body.replace(/(^|\n)\s*(`{3,}|~{3,})[\s\S]*?\n\s*\2[^\n]*/g, '\n').replace(/`[^`\n]*`/g, '');
	const pattern = /!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^)\n]+)\)|<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
	for (const match of withoutCode.matchAll(pattern)) {
		const ref = cleanImageRef(match[1] ?? match[2] ?? match[3] ?? '');
		if (ref) candidates.push(ref);
	}
	return { disabled: false, explicit: explicitRef, candidates: [...new Set(candidates)] };
}

function cleanImageRef(value: string): string {
	let ref = value.trim();
	if (ref.startsWith('"') && ref.endsWith('"')) ref = ref.slice(1, -1).trim();
	if (ref.startsWith('[[') && ref.endsWith(']]')) ref = ref.slice(2, -2);
	if (ref.startsWith('![[') && ref.endsWith(']]')) ref = ref.slice(3, -2);
	if (/^https?:\/\//i.test(ref)) return ref.split(/\s+/)[0] ?? '';
	// Markdown link with a title: `path "title"`. Angle brackets allow spaces.
	ref = ref.replace(/\s+(?:"[^"]*"|'[^']*')$/, '');
	if (ref.startsWith('<') && ref.endsWith('>')) ref = ref.slice(1, -1);
	ref = ref.split('|')[0] ?? '';
	ref = ref.split('#')[0] ?? '';
	try {
		ref = decodeURIComponent(ref);
	} catch {
		// Keep it as written.
	}
	return ref.trim();
}

export function isPhotoPath(path: string): boolean {
	const extension = path.split('?')[0]?.split('.').pop()?.toLowerCase() ?? '';
	return (PHOTO_EXTENSIONS as readonly string[]).includes(extension);
}

export function photoMimeType(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase();
	if (extension === 'png') return 'image/png';
	if (extension === 'webp') return 'image/webp';
	return 'image/jpeg';
}

export function noteTitleAndExcerpt(content: string, apiPath: string): { title: string; excerpt: string } {
	const { raw, body } = splitFrontmatter(content);
	const frontmatterTitle = raw ? readFrontmatterScalar(raw, 'title')?.trim() : undefined;
	const leaf = apiPath.split('/').pop()?.replace(/\.md$/i, '') ?? apiPath;
	const title = frontmatterTitle || titleFromBody(body, leaf);
	return { title, excerpt: excerptFromBody(body) };
}

/** Short text that says what the post is, for notices and the dialog. */
export function describeParts(parts: TelegramPart[]): string {
	const photo = parts[0]?.kind === 'photo';
	const count = parts.length;
	if (photo && count === 1) return 'a photo with a caption';
	if (photo) return `a photo and ${count - 1} more ${count === 2 ? 'message' : 'messages'}`;
	return count === 1 ? 'one message' : `${count} messages`;
}

function sameText(left: string, right: string): boolean {
	const clean = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
	return clean(left) === clean(right);
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
	for (const block of body.replace(/%%[\s\S]*?%%/g, '').split(/\n{2,}/)) {
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
		.replace(/!\[\[[^\]]*\]\]/g, '')
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
