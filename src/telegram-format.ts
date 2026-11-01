/**
 * Markdown (Obsidian flavour) to Telegram HTML.
 *
 * Telegram supports a small set of tags: b, i, u, s, tg-spoiler, a, code,
 * pre, and blockquote (optionally expandable). Headings and lists do not
 * exist there, so they become bold lines and bullet characters.
 *
 * The note is parsed into blocks of styled runs. Runs are plain text plus
 * the marks that apply to them. That keeps three things exact:
 * - the visible length Telegram counts (4096 per message, 1024 per caption),
 * - splitting a long note between messages without breaking a tag,
 * - the preview in Obsidian, which draws the same runs.
 */

export type MarkType = 'blockquote' | 'a' | 'b' | 'i' | 'u' | 's' | 'spoiler' | 'code' | 'pre';

export interface Mark {
	type: MarkType;
	/** Link target, for `a`. */
	href?: string;
	/** Code language, for `pre`. */
	lang?: string;
	/** Collapsed quote, for `blockquote`. */
	expandable?: boolean;
}

export interface Run {
	text: string;
	marks: Mark[];
}

export type BlockKind = 'title' | 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'table' | 'rule' | 'footer';

export interface Block {
	kind: BlockKind;
	runs: Run[];
}

/** A finished Telegram message body. */
export interface RenderedText {
	runs: Run[];
	html: string;
	plain: string;
	/** UTF-16 length after entity parsing, the number Telegram limits. */
	length: number;
}

export interface FormatContext {
	/**
	 * Public URL for a link target inside the vault: a wikilink target like
	 * `diary/hello` or `hello#Heading`, or a relative Markdown path. Null when
	 * the target is not a published note; the link text stays as plain text.
	 */
	resolveNote?: (target: string) => string | null;
}

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
/**
 * Telegram clients stop applying formatting after a large number of
 * entities. Keep each message well under that so nothing renders as raw text.
 */
export const TELEGRAM_ENTITY_LIMIT = 100;

const BLOCK_SEPARATOR = '\n\n';
const INDENT = '    ';
const BULLETS = ['•', '◦', '▪'];
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|tiff?)$/i;
const CALLOUT_ICONS: Record<string, string> = {
	note: '📝',
	abstract: '📋',
	summary: '📋',
	tldr: '📋',
	info: 'ℹ️',
	todo: '☑️',
	tip: '💡',
	hint: '💡',
	important: '💡',
	success: '✅',
	check: '✅',
	done: '✅',
	question: '❓',
	help: '❓',
	faq: '❓',
	warning: '⚠️',
	caution: '⚠️',
	attention: '⚠️',
	failure: '❌',
	fail: '❌',
	missing: '❌',
	danger: '⛔',
	error: '⛔',
	bug: '🐞',
	example: '🧪',
	quote: '💬',
	cite: '💬',
};

const MARK_ORDER: Record<MarkType, number> = {
	blockquote: 0,
	pre: 1,
	a: 2,
	b: 3,
	i: 4,
	u: 5,
	s: 6,
	spoiler: 7,
	code: 8,
};

// ---------------------------------------------------------------------------
// Block level
// ---------------------------------------------------------------------------

/** Parse a note body (frontmatter already removed) into blocks. */
export function markdownToBlocks(markdown: string, context: FormatContext = {}): Block[] {
	const lines = stripComments(markdown.replace(/\r\n?/g, '\n')).split('\n');
	return parseLines(lines, context, false);
}

function parseLines(lines: string[], context: FormatContext, insideQuote: boolean): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	let paragraph: string[] = [];

	const flushParagraph = (): void => {
		if (paragraph.length === 0) return;
		const runs = parseInline(paragraph.join('\n'), context);
		paragraph = [];
		const trimmed = trimRuns(runs);
		if (trimmed.length > 0) blocks.push({ kind: 'paragraph', runs: trimmed });
	};

	while (i < lines.length) {
		const line = lines[i] ?? '';
		const trimmed = line.trim();

		// Fenced code.
		const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/);
		if (fence) {
			flushParagraph();
			const marker = fence[1] ?? '```';
			const lang = sanitizeLang(fence[2] ?? '');
			const code: string[] = [];
			i += 1;
			while (i < lines.length) {
				const inner = lines[i] ?? '';
				if (inner.trim().startsWith(marker.charAt(0).repeat(marker.length)) && inner.trim().replace(/[`~]/g, '') === '') {
					i += 1;
					break;
				}
				code.push(inner);
				i += 1;
			}
			const text = trimBlankEdges(code).join('\n');
			if (!text.trim()) continue;
			if (lang === 'mermaid' || lang === 'dataview' || lang === 'dataviewjs' || lang === 'query') {
				// Rendered views in Obsidian. The source would only confuse readers.
				continue;
			}
			blocks.push(codeBlock(text, lang, insideQuote));
			continue;
		}

		// Display math: `$$…$$` on one line, or `$$` lines around a block.
		if (trimmed.startsWith('$$') && isDisplayMath(lines, i)) {
			flushParagraph();
			const rest = trimmed.slice(2);
			const math: string[] = [];
			if (rest.endsWith('$$') && rest.length >= 2) {
				math.push(rest.slice(0, -2));
				i += 1;
			} else {
				if (rest) math.push(rest);
				i += 1;
				while (i < lines.length) {
					const inner = (lines[i] ?? '').trim();
					i += 1;
					if (inner.endsWith('$$')) {
						if (inner.length > 2) math.push(inner.slice(0, -2));
						break;
					}
					math.push(inner);
				}
			}
			const text = math.join('\n').trim();
			if (text) blocks.push(codeBlock(text, '', insideQuote));
			continue;
		}

		if (!trimmed) {
			flushParagraph();
			i += 1;
			continue;
		}

		// Heading.
		const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
		if (heading) {
			flushParagraph();
			const runs = trimRuns(addMark(parseInline(heading[2] ?? '', context), { type: 'b' }));
			if (runs.length > 0) blocks.push({ kind: 'heading', runs });
			i += 1;
			continue;
		}

		// Horizontal rule.
		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) && paragraph.length === 0) {
			blocks.push({ kind: 'rule', runs: [{ text: '———', marks: [] }] });
			i += 1;
			continue;
		}

		// Quote or callout.
		if (/^\s{0,3}>/.test(line)) {
			flushParagraph();
			const quoted: string[] = [];
			while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) {
				quoted.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''));
				i += 1;
			}
			const block = quoteBlock(quoted, context, insideQuote);
			if (block) blocks.push(...block);
			continue;
		}

		// Table.
		if (trimmed.startsWith('|') && isTableSeparator(lines[i + 1] ?? '')) {
			flushParagraph();
			const rows: string[] = [line];
			i += 2;
			while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
				rows.push(lines[i] ?? '');
				i += 1;
			}
			blocks.push(tableBlock(rows, context, insideQuote));
			continue;
		}

		// List.
		if (LIST_ITEM.test(line)) {
			flushParagraph();
			const items: string[] = [];
			while (i < lines.length) {
				const current = lines[i] ?? '';
				if (LIST_ITEM.test(current)) {
					items.push(current);
					i += 1;
					continue;
				}
				// A lazy continuation line belongs to the item above it.
				if (current.trim() && /^\s+/.test(current) && items.length > 0 && !/^\s*(`{3,}|~{3,})/.test(current)) {
					items[items.length - 1] += `\n${current.trim()}`;
					i += 1;
					continue;
				}
				break;
			}
			const block = listBlock(items, context);
			if (block) blocks.push(block);
			continue;
		}

		// A line that is only embeds (images, transclusions) is dropped. The
		// cover image is sent as a photo, and the page link has the rest.
		if (isEmbedOnlyLine(trimmed)) {
			flushParagraph();
			i += 1;
			continue;
		}

		// Footnote definition.
		const footnote = trimmed.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
		if (footnote) {
			flushParagraph();
			const runs = trimRuns([
				{ text: `[${footnote[1] ?? ''}] `, marks: [] },
				...parseInline(footnote[2] ?? '', context),
			]);
			blocks.push({ kind: 'paragraph', runs });
			i += 1;
			continue;
		}

		paragraph.push(trimmed.replace(/\s{2,}$/, ''));
		i += 1;
	}
	flushParagraph();
	return blocks;
}

function isDisplayMath(lines: string[], start: number): boolean {
	const first = (lines[start] ?? '').trim();
	if (first.length >= 4 && first.endsWith('$$')) return true;
	if (first !== '$$' && first.slice(2).includes('$$')) return false;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = (lines[index] ?? '').trim();
		if (!line) return false;
		if (line.endsWith('$$')) return true;
	}
	return false;
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** One item with its continuation lines (`\n` inside the item). */
const LIST_ITEM_WITH_BODY = /^(\s*)([-*+]|\d{1,9}[.)])\s+([\s\S]*)$/;

function listBlock(items: string[], context: FormatContext): Block | null {
	const runs: Run[] = [];
	const indents: number[] = [];
	for (const item of items) {
		const match = item.match(LIST_ITEM_WITH_BODY);
		if (!match) continue;
		const width = (match[1] ?? '').replace(/\t/g, '    ').length;
		while (indents.length > 0 && (indents[indents.length - 1] ?? 0) > width) indents.pop();
		if (indents.length === 0 || (indents[indents.length - 1] ?? 0) < width) indents.push(width);
		const depth = Math.max(0, indents.length - 1);
		const marker = match[2] ?? '-';
		let body = match[3] ?? '';
		let prefix: string;
		const task = body.match(/^\[([ xX/\-])\]\s+(.*)$/s);
		if (task) {
			const state = task[1] ?? ' ';
			prefix = state === ' ' ? '☐ ' : state === '-' ? '☒ ' : '☑ ';
			body = task[2] ?? '';
		} else if (/^\d/.test(marker)) {
			prefix = `${marker.replace(')', '.')} `;
		} else {
			prefix = `${BULLETS[depth % BULLETS.length] ?? '•'} `;
		}
		if (runs.length > 0) runs.push({ text: '\n', marks: [] });
		runs.push({ text: INDENT.repeat(depth) + prefix, marks: [] });
		// Continuation lines sit under the item's text, not under the bullet.
		const hanging = `\n${INDENT.repeat(depth + 1)}`;
		for (const run of trimRuns(parseInline(body, context))) {
			runs.push({ text: run.text.replace(/\n/g, hanging), marks: run.marks });
		}
	}
	const merged = mergeRuns(runs);
	return merged.length > 0 ? { kind: 'list', runs: merged } : null;
}

function quoteBlock(lines: string[], context: FormatContext, insideQuote: boolean): Block[] | null {
	const first = lines[0] ?? '';
	const callout = first.match(/^\s*\[!([A-Za-z0-9_-]+)\]([+-]?)\s*(.*)$/);
	let header: Run[] = [];
	let expandable = false;
	let body = lines;
	if (callout) {
		const type = (callout[1] ?? 'note').toLowerCase();
		const icon = CALLOUT_ICONS[type] ?? '📌';
		const title = (callout[3] ?? '').trim() || capitalize(type);
		header = [
			{ text: `${icon} `, marks: [] },
			...addMark(parseInline(title, context), { type: 'b' }),
		];
		expandable = callout[2] === '-';
		body = lines.slice(1);
	}
	const inner = parseLines(body, context, true);
	const runs: Run[] = [...header];
	for (const block of inner) {
		if (runs.length > 0) runs.push({ text: '\n', marks: [] });
		runs.push(...block.runs);
	}
	const trimmed = trimRuns(runs);
	if (trimmed.length === 0) return null;
	if (insideQuote) {
		// Telegram cannot nest quotes. The outer quote already wraps this text.
		return [{ kind: 'quote', runs: trimmed }];
	}
	return [{ kind: 'quote', runs: addMark(trimmed, { type: 'blockquote', expandable: expandable || undefined }) }];
}

function codeBlock(text: string, lang: string, insideQuote: boolean): Block {
	if (insideQuote) {
		// `pre` cannot sit inside a quote. Monospace lines read the same.
		return { kind: 'code', runs: [{ text, marks: [{ type: 'code' }] }] };
	}
	return { kind: 'code', runs: [{ text, marks: [{ type: 'pre', lang: lang || undefined }] }] };
}

function tableBlock(rows: string[], context: FormatContext, insideQuote: boolean): Block {
	const cells = rows.map((row) =>
		splitTableRow(row).map((cell) => runsToPlain(parseInline(cell, context)).replace(/\s+/g, ' ').trim()),
	);
	const columns = Math.max(...cells.map((row) => row.length));
	// Count code points, so an emoji is one column and is never cut in half.
	const width = (value: string): number => Array.from(value).length;
	const widths: number[] = [];
	for (let column = 0; column < columns; column += 1) {
		widths.push(Math.min(24, Math.max(1, ...cells.map((row) => width(row[column] ?? '')))));
	}
	const lines = cells.map((row) =>
		widths
			.map((size, column) => {
				const value = row[column] ?? '';
				const points = Array.from(value);
				return points.length > size
					? `${points.slice(0, size - 1).join('')}…`
					: value + ' '.repeat(size - points.length);
			})
			.join(' │ ')
			.trimEnd(),
	);
	const rule = widths.map((width) => '─'.repeat(width)).join('─┼─');
	lines.splice(1, 0, rule);
	return codeBlock(lines.join('\n'), '', insideQuote);
}

function splitTableRow(row: string): string[] {
	let body = row.trim();
	if (body.startsWith('|')) body = body.slice(1);
	if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
	const cells: string[] = [];
	let current = '';
	let inCode = false;
	for (let i = 0; i < body.length; i += 1) {
		const char = body.charAt(i);
		if (char === '\\' && body.charAt(i + 1) === '|') {
			current += '|';
			i += 1;
			continue;
		}
		if (char === '`') inCode = !inCode;
		if (char === '|' && !inCode) {
			cells.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	cells.push(current);
	return cells;
}

function isTableSeparator(line: string): boolean {
	return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-') && line.includes('|');
}

function isEmbedOnlyLine(line: string): boolean {
	const rest = line
		.replace(/!\[\[[^\]\n]*\]\]/g, '')
		.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
		.replace(/<(?:img|video|audio|iframe)\b[^>]*\/?>(?:<\/(?:video|audio|iframe)>)?/gi, '')
		.trim();
	return rest === '' && line !== '';
}

function stripComments(text: string): string {
	// Keep fenced code as written. Comments outside it are private.
	const parts = text.split(/(^\s*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*(?:`{3,}|~{3,})\s*$)/m);
	return parts
		.map((part, index) =>
			index % 2 === 1 ? part : part.replace(/%%[\s\S]*?%%/g, '').replace(/<!--[\s\S]*?-->/g, ''),
		)
		.join('');
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && !(lines[start] ?? '').trim()) start += 1;
	while (end > start && !(lines[end - 1] ?? '').trim()) end -= 1;
	return lines.slice(start, end);
}

function sanitizeLang(value: string): string {
	const clean = value.replace(/^\{?\.?/, '').replace(/\}$/, '').toLowerCase();
	return /^[a-z0-9_+#.-]{1,32}$/.test(clean) ? clean : '';
}

// ---------------------------------------------------------------------------
// Inline level
// ---------------------------------------------------------------------------

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~=<>$%&"']/;

/** Parse inline Markdown into runs. */
export function parseInline(text: string, context: FormatContext = {}, marks: Mark[] = []): Run[] {
	const runs: Run[] = [];
	let buffer = '';
	const flush = (): void => {
		if (buffer) runs.push({ text: decodeEntities(buffer), marks });
		buffer = '';
	};
	const push = (inner: Run[]): void => {
		flush();
		runs.push(...inner);
	};

	let i = 0;
	while (i < text.length) {
		const char = text.charAt(i);
		const rest = text.slice(i);

		if (char === '\\') {
			const next = text.charAt(i + 1);
			if (next && ESCAPABLE.test(next)) {
				buffer += next;
				i += 2;
				continue;
			}
			if (next === '\n') {
				buffer += '\n';
				i += 2;
				continue;
			}
		}

		if (char === '`') {
			const ticks = rest.match(/^`+/)?.[0] ?? '`';
			const close = text.indexOf(ticks, i + ticks.length);
			if (close > i) {
				let code = text.slice(i + ticks.length, close);
				if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
				push([{ text: code, marks: [...marks, { type: 'code' }] }]);
				i = close + ticks.length;
				continue;
			}
			buffer += ticks;
			i += ticks.length;
			continue;
		}

		// Embeds: images are the photo's job; a transcluded note becomes a link.
		if (rest.startsWith('![[')) {
			const close = text.indexOf(']]', i + 3);
			if (close > i) {
				const inner = text.slice(i + 3, close);
				const target = inner.split('|')[0]?.trim() ?? '';
				if (!IMAGE_EXTENSIONS.test(target.split('#')[0] ?? '') && !/\.(pdf|mp[34]|mov|webm|wav|ogg|m4a)$/i.test(target)) {
					const url = context.resolveNote?.(target) ?? null;
					const label = wikiLabel(inner);
					if (url && label) push([{ text: label, marks: [...marks, { type: 'a', href: url }] }]);
				}
				i = close + 2;
				continue;
			}
		}

		if (rest.startsWith('[[')) {
			const close = text.indexOf(']]', i + 2);
			if (close > i) {
				const inner = text.slice(i + 2, close);
				const target = inner.split('|')[0]?.trim() ?? '';
				const label = wikiLabel(inner);
				const url = target.startsWith('#') ? null : (context.resolveNote?.(target) ?? null);
				if (label) {
					push(
						url
							? parseInline(label, context, [...marks, { type: 'a', href: url }])
							: parseInline(label, context, marks),
					);
				}
				i = close + 2;
				continue;
			}
		}

		if (rest.startsWith('![')) {
			const image = matchLink(text, i + 1);
			if (image) {
				i = image.end;
				continue;
			}
		}

		if (char === '[') {
			const footnoteRef = rest.match(/^\[\^([^\]\s]+)\]/);
			if (footnoteRef) {
				buffer += `[${footnoteRef[1] ?? ''}]`;
				i += footnoteRef[0].length;
				continue;
			}
			const link = matchLink(text, i);
			if (link) {
				const href = resolveHref(link.href, context);
				const inner = parseInline(link.label, context, href ? [...marks, { type: 'a', href }] : marks);
				push(inner);
				i = link.end;
				continue;
			}
		}

		if (char === '<') {
			const autolink = rest.match(/^<((?:https?|mailto|tg):[^\s<>]+)>/i);
			if (autolink) {
				const href = autolink[1] ?? '';
				// Telegram links e-mail addresses itself; only web links get a tag.
				const mail = /^mailto:/i.test(href);
				push([{ text: href.replace(/^mailto:/i, ''), marks: mail ? marks : [...marks, { type: 'a', href }] }]);
				i += autolink[0].length;
				continue;
			}
			const br = rest.match(/^<br\s*\/?>/i);
			if (br) {
				buffer += '\n';
				i += br[0].length;
				continue;
			}
			const tag = rest.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/);
			if (tag) {
				const name = (tag[1] ?? '').toLowerCase();
				const mapped = HTML_INLINE[name];
				if (mapped && !tag[0].startsWith('</')) {
					const closeTag = new RegExp(`</${name}\\s*>`, 'i');
					const after = text.slice(i + tag[0].length);
					const end = after.search(closeTag);
					if (end >= 0) {
						const closeLength = after.slice(end).match(closeTag)?.[0].length ?? 0;
						push(parseInline(after.slice(0, end), context, [...marks, { type: mapped }]));
						i += tag[0].length + end + closeLength;
						continue;
					}
				}
				// Other HTML is layout for the site. Keep the words, drop the tag.
				i += tag[0].length;
				continue;
			}
		}

		const delimiter = matchDelimiter(text, i);
		if (delimiter) {
			const inner = text.slice(i + delimiter.open.length, delimiter.close);
			const added = delimiter.marks.map((type) => ({ type }) as Mark);
			push(parseInline(inner, context, [...marks, ...added]));
			i = delimiter.close + delimiter.open.length;
			continue;
		}

		if (rest.startsWith('$$')) {
			const close = text.indexOf('$$', i + 2);
			const inner = close > i ? text.slice(i + 2, close) : '';
			if (inner.trim() && !inner.includes('\n')) {
				push([{ text: inner.trim(), marks: [...marks, { type: 'code' }] }]);
				i = close + 2;
				continue;
			}
		}

		if (char === '$' && !/\d/.test(text.charAt(i + 1))) {
			const close = findInlineMath(text, i);
			if (close > i) {
				push([{ text: text.slice(i + 1, close), marks: [...marks, { type: 'code' }] }]);
				i = close + 1;
				continue;
			}
		}

		buffer += char;
		i += 1;
	}
	flush();
	return mergeRuns(runs);
}

const HTML_INLINE: Record<string, MarkType> = {
	b: 'b',
	strong: 'b',
	i: 'i',
	em: 'i',
	u: 'u',
	ins: 'u',
	s: 's',
	del: 's',
	strike: 's',
	code: 'code',
	kbd: 'code',
	mark: 'b',
};

function matchDelimiter(
	text: string,
	start: number,
): { open: string; close: number; marks: MarkType[] } | null {
	const candidates: Array<{ open: string; marks: MarkType[] }> = [
		{ open: '***', marks: ['b', 'i'] },
		{ open: '___', marks: ['b', 'i'] },
		{ open: '**', marks: ['b'] },
		{ open: '__', marks: ['b'] },
		{ open: '~~', marks: ['s'] },
		{ open: '==', marks: ['b'] },
		{ open: '||', marks: ['spoiler'] },
		{ open: '*', marks: ['i'] },
		{ open: '_', marks: ['i'] },
	];
	for (const candidate of candidates) {
		const { open } = candidate;
		if (!text.startsWith(open, start)) continue;
		const after = text.charAt(start + open.length);
		if (!after || /\s/.test(after)) continue;
		const before = start > 0 ? text.charAt(start - 1) : '';
		// snake_case_words are not emphasis.
		if (open.startsWith('_') && /[A-Za-z0-9]/.test(before)) continue;
		const close = findCloser(text, start + open.length, open);
		if (close < 0) continue;
		return { open, close, marks: candidate.marks };
	}
	return null;
}

/**
 * Emphasis and link searches stop after this many characters. Real emphasis
 * is far shorter, and the cap keeps a paragraph full of stray `*` linear
 * instead of quadratic on the UI thread.
 */
const SEARCH_LIMIT = 3000;

function findCloser(text: string, from: number, delimiter: string): number {
	const single = delimiter.length === 1;
	const char = delimiter.charAt(0);
	let i = from;
	const end = Math.min(text.length, from + SEARCH_LIMIT);
	while (i < end) {
		const current = text.charAt(i);
		if (current === '\\') {
			i += 2;
			continue;
		}
		if (current === '`') {
			const ticks = text.slice(i).match(/^`+/)?.[0] ?? '`';
			const close = text.indexOf(ticks, i + ticks.length);
			i = close > i ? close + ticks.length : i + ticks.length;
			continue;
		}
		if (current === '\n' && text.charAt(i + 1) === '\n') return -1;
		if (text.startsWith(delimiter, i)) {
			const before = text.charAt(i - 1);
			const after = text.charAt(i + delimiter.length);
			if (single) {
				// `*a **b** c*`: skip a doubled marker, it belongs to bold.
				if (text.charAt(i + 1) === char || text.charAt(i - 1) === char) {
					let j = i;
					while (text.charAt(j) === char) j += 1;
					const runLength = j - i;
					if (runLength === 2) {
						i = j;
						continue;
					}
					if (runLength === 3 && !/\s/.test(before)) return i + 2;
				}
			}
			if (i > from && !/\s/.test(before) && !(delimiter.startsWith('_') && /[A-Za-z0-9]/.test(after))) {
				return i;
			}
		}
		i += 1;
	}
	return -1;
}

function findInlineMath(text: string, start: number): number {
	const after = text.charAt(start + 1);
	if (!after || /\s/.test(after) || after === '$') return -1;
	for (let i = start + 1; i < text.length; i += 1) {
		const char = text.charAt(i);
		if (char === '\n') return -1;
		if (char === '\\') {
			i += 1;
			continue;
		}
		if (char === '$') {
			if (/\s/.test(text.charAt(i - 1))) return -1;
			if (/\d/.test(text.charAt(i + 1))) return -1;
			return i;
		}
	}
	return -1;
}

function matchLink(text: string, start: number): { label: string; href: string; end: number } | null {
	if (text.charAt(start) !== '[') return null;
	let depth = 0;
	let labelEnd = -1;
	const labelLimit = Math.min(text.length, start + SEARCH_LIMIT);
	for (let i = start; i < labelLimit; i += 1) {
		const char = text.charAt(i);
		if (char === '\\') {
			i += 1;
			continue;
		}
		if (char === '[') depth += 1;
		if (char === ']') {
			depth -= 1;
			if (depth === 0) {
				labelEnd = i;
				break;
			}
		}
		if (char === '\n' && text.charAt(i + 1) === '\n') return null;
	}
	if (labelEnd < 0 || text.charAt(labelEnd + 1) !== '(') return null;
	let parens = 0;
	let hrefEnd = -1;
	const hrefLimit = Math.min(text.length, labelEnd + 1 + SEARCH_LIMIT);
	for (let i = labelEnd + 1; i < hrefLimit; i += 1) {
		const char = text.charAt(i);
		if (char === '\\') {
			i += 1;
			continue;
		}
		if (char === '(') parens += 1;
		if (char === ')') {
			parens -= 1;
			if (parens === 0) {
				hrefEnd = i;
				break;
			}
		}
		if (char === '\n') return null;
	}
	if (hrefEnd < 0) return null;
	let href = text.slice(labelEnd + 2, hrefEnd).trim();
	// Drop an optional "title".
	href = href.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/, '');
	if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
	return { label: text.slice(start + 1, labelEnd), href, end: hrefEnd + 1 };
}

function resolveHref(raw: string, context: FormatContext): string | null {
	const href = raw.trim();
	if (!href) return null;
	if (/^(https?|tg):\/\//i.test(href)) return safeUrl(href);
	if (href.startsWith('#')) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
	let target = href;
	try {
		target = decodeURIComponent(href);
	} catch {
		// Keep the raw text.
	}
	return context.resolveNote?.(target) ?? null;
}

function safeUrl(url: string): string | null {
	if (/[\s<>"]/.test(url)) {
		const encoded = url.replace(/[\s<>"]/g, (char) => encodeURIComponent(char));
		return encoded.length <= 2048 ? encoded : null;
	}
	return url.length <= 2048 ? url : null;
}

function wikiLabel(inner: string): string {
	const [target = '', alias] = inner.split('|');
	if (alias !== undefined && alias.trim()) return alias.trim();
	const [file = '', heading] = target.split('#');
	const leaf = file.split('/').pop()?.replace(/\.md$/i, '').trim() ?? '';
	const section = heading?.replace(/^\^/, '').trim();
	if (leaf && section) return `${leaf} › ${section}`;
	return leaf || section || '';
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	laquo: '«',
	raquo: '»',
	copy: '©',
	reg: '®',
	trade: '™',
	middot: '·',
	bull: '•',
	rarr: '→',
	larr: '←',
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
		if (entity.startsWith('#x') || entity.startsWith('#X')) {
			const code = Number.parseInt(entity.slice(2), 16);
			return validCodePoint(code) ? String.fromCodePoint(code) : match;
		}
		if (entity.startsWith('#')) {
			const code = Number.parseInt(entity.slice(1), 10);
			return validCodePoint(code) ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function validCodePoint(code: number): boolean {
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function sameMark(left: Mark, right: Mark): boolean {
	return (
		left.type === right.type &&
		left.href === right.href &&
		left.lang === right.lang &&
		Boolean(left.expandable) === Boolean(right.expandable)
	);
}

function sameMarks(left: Mark[], right: Mark[]): boolean {
	return left.length === right.length && left.every((mark, index) => sameMark(mark, right[index] as Mark));
}

/**
 * Telegram nesting rules: code and pre hold no other entity, a link holds no
 * other link, and blockquotes do not nest. Keep the outer meaning and sort.
 */
export function normalizeMarks(marks: Mark[]): Mark[] {
	const unique: Mark[] = [];
	for (const mark of marks) {
		if (unique.some((existing) => existing.type === mark.type)) continue;
		unique.push(mark);
	}
	let kept = unique;
	if (kept.some((mark) => mark.type === 'pre')) {
		kept = kept.filter((mark) => mark.type === 'pre');
	} else if (kept.some((mark) => mark.type === 'code')) {
		kept = kept.filter((mark) => mark.type === 'code' || mark.type === 'blockquote');
	}
	return [...kept].sort((a, b) => MARK_ORDER[a.type] - MARK_ORDER[b.type]);
}

export function mergeRuns(runs: Run[]): Run[] {
	const merged: Run[] = [];
	for (const run of runs) {
		if (!run.text) continue;
		const marks = normalizeMarks(run.marks);
		const last = merged[merged.length - 1];
		if (last && sameMarks(last.marks, marks)) {
			last.text += run.text;
		} else {
			merged.push({ text: run.text, marks });
		}
	}
	return merged;
}

function addMark(runs: Run[], mark: Mark): Run[] {
	return mergeRuns(runs.map((run) => ({ text: run.text, marks: [mark, ...run.marks] })));
}

/** Remove leading and trailing whitespace across runs. Indentation (nbsp) stays. */
export function trimRuns(runs: Run[]): Run[] {
	return trimPieceEnd(trimPieceStart(runs));
}

export function runsToPlain(runs: Run[]): string {
	return runs.map((run) => run.text).join('');
}

export function visibleLength(runs: Run[]): number {
	let length = 0;
	for (const run of runs) length += run.text.length;
	return length;
}

/** How many entities Telegram will see: one per contiguous mark span. */
export function entityCount(runs: Run[]): number {
	let count = 0;
	let open: Mark[] = [];
	for (const run of runs) {
		const common = commonPrefix(open, run.marks);
		count += run.marks.length - common;
		open = run.marks;
	}
	return count;
}

function commonPrefix(left: Mark[], right: Mark[]): number {
	let index = 0;
	while (index < left.length && index < right.length && sameMark(left[index] as Mark, right[index] as Mark)) {
		index += 1;
	}
	return index;
}

export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/"/g, '&quot;');
}

function openTag(mark: Mark): string {
	switch (mark.type) {
		case 'a':
			return `<a href="${escapeAttribute(mark.href ?? '')}">`;
		case 'pre':
			return mark.lang ? `<pre><code class="language-${escapeAttribute(mark.lang)}">` : '<pre>';
		case 'blockquote':
			return mark.expandable ? '<blockquote expandable>' : '<blockquote>';
		case 'spoiler':
			return '<tg-spoiler>';
		default:
			return `<${mark.type}>`;
	}
}

function closeTag(mark: Mark): string {
	switch (mark.type) {
		case 'pre':
			return mark.lang ? '</code></pre>' : '</pre>';
		case 'spoiler':
			return '</tg-spoiler>';
		default:
			return `</${mark.type}>`;
	}
}

/** Telegram HTML with each tag opened and closed once per span. */
export function runsToHtml(runs: Run[]): string {
	let html = '';
	let open: Mark[] = [];
	for (const run of runs) {
		const common = commonPrefix(open, run.marks);
		for (let index = open.length - 1; index >= common; index -= 1) html += closeTag(open[index] as Mark);
		for (let index = common; index < run.marks.length; index += 1) html += openTag(run.marks[index] as Mark);
		html += escapeHtml(run.text);
		open = run.marks;
	}
	for (let index = open.length - 1; index >= 0; index -= 1) html += closeTag(open[index] as Mark);
	return html;
}

export function renderRuns(runs: Run[]): RenderedText {
	const merged = mergeRuns(runs);
	return {
		runs: merged,
		html: runsToHtml(merged),
		plain: runsToPlain(merged),
		length: visibleLength(merged),
	};
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/** Join blocks with a blank line between them. */
export function joinBlocks(blocks: Block[]): Run[] {
	const runs: Run[] = [];
	for (const block of blocks) {
		if (runs.length > 0) runs.push({ text: BLOCK_SEPARATOR, marks: [] });
		runs.push(...block.runs);
	}
	return mergeRuns(runs);
}

/**
 * Pack blocks into messages. `limitFor(index)` is the visible-length limit of
 * message `index` (a photo caption is shorter). Blocks stay whole when they
 * fit; a block longer than a message is cut at a line, a sentence, or a word.
 */
export function packBlocks(
	blocks: Block[],
	limitFor: (index: number) => number,
	entityLimit = TELEGRAM_ENTITY_LIMIT,
): Run[][] {
	const messages: Run[][] = [];
	let current: Block[] = [];
	let currentLength = 0;
	let currentEntities = 0;
	const queue = blocks.filter((block) => visibleLength(block.runs) > 0).map((block) => ({ ...block }));

	const flush = (): void => {
		if (current.length === 0) return;
		messages.push(joinBlocks(current));
		current = [];
		currentLength = 0;
		currentEntities = 0;
	};

	const add = (block: Block): void => {
		const separator = current.length > 0 ? BLOCK_SEPARATOR.length : 0;
		current.push(block);
		currentLength += separator + visibleLength(block.runs);
		currentEntities += entityCount(block.runs);
	};

	while (queue.length > 0) {
		const block = queue.shift() as Block;
		const limit = limitFor(messages.length);
		const length = visibleLength(block.runs);
		const entities = entityCount(block.runs);
		const separator = current.length > 0 ? BLOCK_SEPARATOR.length : 0;
		const entitiesFit = currentEntities + entities <= entityLimit;
		if (currentLength + separator + length <= limit && entitiesFit) {
			add(block);
			continue;
		}
		const lineCut = block.kind === 'code' || block.kind === 'table' || block.kind === 'list' || block.kind === 'quote';
		if (current.length > 0) {
			const room = limit - currentLength - separator;
			const fitsNext = length <= limitFor(messages.length + 1);
			// A block that fits a whole message moves there instead of being cut.
			if (fitsNext || !entitiesFit || room < Math.min(400, limit / 4)) {
				flush();
				queue.unshift(block);
				continue;
			}
			const [head, tail] = splitRuns(block.runs, room, lineCut);
			if (head.length === 0) {
				flush();
				queue.unshift(block);
				continue;
			}
			add({ kind: block.kind, runs: head });
			flush();
			if (tail.length > 0) queue.unshift({ kind: block.kind, runs: tail });
			continue;
		}
		if (length <= limit) {
			// Alone in a message and only over the entity budget. Send it as is.
			add(block);
			flush();
			continue;
		}
		const [head, tail] = splitRuns(block.runs, limit, lineCut);
		add({ kind: block.kind, runs: head.length > 0 ? head : block.runs });
		flush();
		if (head.length > 0 && tail.length > 0) queue.unshift({ kind: block.kind, runs: tail });
	}
	flush();
	return messages;
}

/**
 * Cut runs so the head is at most `limit` characters. Prefers a line break,
 * then the end of a sentence, then a space. Marks continue into the tail, so
 * bold text cut in half is bold in both messages.
 */
export function splitRuns(runs: Run[], limit: number, preferLines = false): [Run[], Run[]] {
	const plain = runsToPlain(runs);
	if (plain.length <= limit) return [runs, []];
	const window = plain.slice(0, limit + 1);
	const floor = Math.floor(limit * (preferLines ? 0.3 : 0.5));
	let cut = -1;
	const newline = window.lastIndexOf('\n', limit);
	if (newline >= floor) cut = newline;
	if (cut < 0) {
		const sentence = lastMatch(window.slice(0, limit), /[.!?…;:](?=\s)/g);
		if (sentence >= floor) cut = sentence + 1;
	}
	if (cut < 0) {
		const space = window.lastIndexOf(' ', limit);
		if (space >= floor) cut = space;
	}
	if (cut <= 0) cut = limit;
	// Never split a surrogate pair.
	const code = plain.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut -= 1;

	const head: Run[] = [];
	const tail: Run[] = [];
	let offset = 0;
	for (const run of runs) {
		const end = offset + run.text.length;
		if (end <= cut) head.push(run);
		else if (offset >= cut) tail.push(run);
		else {
			head.push({ text: run.text.slice(0, cut - offset), marks: run.marks });
			tail.push({ text: run.text.slice(cut - offset), marks: run.marks });
		}
		offset = end;
	}
	return [trimPieceEnd(head), trimPieceStart(tail)];
}

function trimPieceEnd(runs: Run[]): Run[] {
	const copy = runs.map((run) => ({ ...run }));
	while (copy.length > 0) {
		const last = copy[copy.length - 1] as Run;
		last.text = last.text.replace(/[ \t\r\n]+$/, '');
		if (last.text) break;
		copy.pop();
	}
	return mergeRuns(copy);
}

function trimPieceStart(runs: Run[]): Run[] {
	const copy = runs.map((run) => ({ ...run }));
	while (copy.length > 0) {
		const first = copy[0] as Run;
		// Code keeps its indentation; only the line break goes.
		const isCode = first.marks.some((mark) => mark.type === 'pre' || mark.type === 'code');
		first.text = first.text.replace(isCode ? /^[\r\n]+/ : /^[ \t\r\n]+/, '');
		if (first.text) break;
		copy.shift();
	}
	return mergeRuns(copy);
}

function lastMatch(text: string, pattern: RegExp): number {
	let last = -1;
	for (const match of text.matchAll(pattern)) last = match.index ?? last;
	return last;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
