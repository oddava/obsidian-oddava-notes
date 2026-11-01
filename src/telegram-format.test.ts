import { describe, expect, it } from 'vitest';
import {
	entityCount,
	joinBlocks,
	markdownToBlocks,
	packBlocks,
	parseInline,
	renderRuns,
	runsToHtml,
	splitRuns,
	TELEGRAM_CAPTION_LIMIT,
	TELEGRAM_TEXT_LIMIT,
} from './telegram-format';

function html(markdown: string, resolveNote?: (target: string) => string | null): string {
	return runsToHtml(joinBlocks(markdownToBlocks(markdown, { resolveNote })));
}

/** Every opened tag is closed in order, the way Telegram's parser requires. */
function balanced(value: string): boolean {
	const stack: string[] = [];
	for (const match of value.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
		const [, closing, name = ''] = match;
		if (closing) {
			if (stack.pop() !== name) return false;
		} else stack.push(name);
	}
	return stack.length === 0;
}

describe('inline Markdown', () => {
	it('maps emphasis, code, links, and escapes to Telegram tags', () => {
		expect(html('Some **bold**, *italic*, ***both***, ~~gone~~, ==marked==, and `a < b`.')).toBe(
			'Some <b>bold</b>, <i>italic</i>, <b><i>both</i></b>, <s>gone</s>, <b>marked</b>, and <code>a &lt; b</code>.',
		);
		expect(html('[site](https://oddava.me "Title") and <https://t.me/justoddava>')).toBe(
			'<a href="https://oddava.me">site</a> and <a href="https://t.me/justoddava">https://t.me/justoddava</a>',
		);
		expect(html('\\*not italic\\* and snake_case_name and 2 * 3 * 4')).toBe(
			'*not italic* and snake_case_name and 2 * 3 * 4',
		);
		expect(html('Tom &amp; Jerry &mdash; A&B <span class="x">kept</span>')).toBe(
			'Tom &amp; Jerry — A&amp;B kept',
		);
	});

	it('links wikilinks to published notes and keeps the text of the rest', () => {
		const resolve = (target: string): string | null =>
			target.startsWith('diary/hello') ? 'https://oddava.me/notes/diary/hello' : null;
		expect(html('See [[diary/hello|my diary]], [[diary/hello#Monday]], and [[private note]].', resolve)).toBe(
			'See <a href="https://oddava.me/notes/diary/hello">my diary</a>, <a href="https://oddava.me/notes/diary/hello">hello › Monday</a>, and private note.',
		);
		expect(html('[relative](../diary/hello.md) and [nowhere](missing.md)', (target) =>
			target === '../diary/hello.md' ? 'https://oddava.me/notes/diary/hello' : null,
		)).toBe('<a href="https://oddava.me/notes/diary/hello">relative</a> and nowhere');
		expect(html('[js](javascript:alert(1))')).toBe('js');
	});

	it('reads bold and italic that close in either order', () => {
		expect(html('**a *b***')).toBe('<b>a <i>b</i></b>');
		expect(html('***a** b*')).toBe('<b><i>a</i></b><i> b</i>');
		expect(html('*a **b***')).toBe('<i>a </i><b><i>b</i></b>');
		expect(html('***a* b**')).toBe('<b><i>a</i> b</b>');
		expect(html('***both***')).toBe('<b><i>both</i></b>');
		expect(html('__a _b___')).toBe('<b>a <i>b</i></b>');
	});

	it('never nests formatting inside code', () => {
		const runs = parseInline('**bold `code` bold**');
		expect(runsToHtml(runs)).toBe('<b>bold </b><code>code</code><b> bold</b>');
		expect(runsToHtml(parseInline('[**strong link**](https://x.dev)'))).toBe(
			'<a href="https://x.dev"><b>strong link</b></a>',
		);
	});

	it('treats inline math as code and leaves prices alone', () => {
		expect(html('Energy $E = mc^2$ costs $5 and $10.')).toBe('Energy <code>E = mc^2</code> costs $5 and $10.');
	});
});

describe('block Markdown', () => {
	it('renders headings, lists, tasks, quotes, callouts, code, tables, and rules', () => {
		const markdown = [
			'## Plan',
			'',
			'- one',
			'- two',
			'  - nested **b**',
			'- [ ] open task',
			'- [x] done task',
			'',
			'1. first',
			'2. second',
			'',
			'> [!tip]- Quick tip',
			'> Body with `code`',
			'',
			'> plain quote',
			'',
			'```ts',
			'const a = 1 < 2;',
			'  indented();',
			'```',
			'',
			'| a | b |',
			'|---|---|',
			'| 1 | two |',
			'',
			'---',
			'',
			'Footnote[^1].',
			'',
			'[^1]: The note.',
		].join('\n');
		expect(html(markdown)).toBe(
			[
				'<b>Plan</b>',
				'',
				'• one\n• two\n    ◦ nested <b>b</b>\n☐ open task\n☑ done task',
				'',
				'1. first\n2. second',
				'',
				'<blockquote expandable>💡 <b>Quick tip</b>\nBody with <code>code</code></blockquote>',
				'',
				'<blockquote>plain quote</blockquote>',
				'',
				'<pre><code class="language-ts">const a = 1 &lt; 2;\n  indented();</code></pre>',
				'',
				'<pre>a │ b\n──┼────\n1 │ two</pre>',
				'',
				'———',
				'',
				'Footnote[1].',
				'',
				'[1] The note.',
			].join('\n'),
		);
	});

	it('drops comments, image embeds, and Obsidian-only code views', () => {
		const markdown = [
			'Visible %%private%% text.',
			'',
			'%%',
			'whole private block',
			'%%',
			'',
			'<!-- draft -->',
			'![[photo.png]]',
			'![alt](https://example.com/a.jpg)',
			'',
			'```dataview',
			'LIST FROM #notes',
			'```',
			'',
			'```',
			'%% kept inside code %%',
			'```',
		].join('\n');
		expect(html(markdown)).toBe('Visible  text.\n\n<pre>%% kept inside code %%</pre>');
	});

	it('keeps list items that wrap onto more lines, also inside callouts', () => {
		expect(html('- first item\n  wraps here\n- second\n    - nested\n      more')).toBe(
			'• first item\n\u00a0\u00a0\u00a0\u00a0wraps here\n• second\n\u00a0\u00a0\u00a0\u00a0◦ nested\n\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0more',
		);
		expect(html('> [!note] Steps\n> - one\n>   still one\n> - two')).toBe(
			'<blockquote>📝 <b>Steps</b>\n• one\n\u00a0\u00a0\u00a0\u00a0still one\n• two</blockquote>',
		);
	});

	it('keeps text after a one-line formula and a stray $$', () => {
		expect(html('$$x$$ text\nnext\n\nanother paragraph')).toBe('<code>x</code> text\nnext\n\nanother paragraph');
		expect(html('$$\n\nplain')).toBe('$$\n\nplain');
		expect(html('$$\na^2\n$$\n\nafter')).toBe('<pre>a^2</pre>\n\nafter');
		expect(html('$$ e = mc^2 $$')).toBe('<pre>e = mc^2</pre>');
	});

	it('keeps a trailing # that is part of the heading', () => {
		expect(html('## Learning C#')).toBe('<b>Learning C#</b>');
		expect(html('## Closed ##')).toBe('<b>Closed</b>');
	});

	it('truncates table cells by whole characters', () => {
		const cell = '😀'.repeat(30);
		const rendered = html(`| a |\n|---|\n| ${cell} |`);
		expect(rendered).toContain(`${'😀'.repeat(23)}…`);
		expect(rendered).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
	});

	it('keeps single line breaks inside a paragraph', () => {
		expect(html('line one\nline two')).toBe('line one\nline two');
	});
});

describe('splitting into messages', () => {
	const paragraph = (index: number): string =>
		`Paragraph ${index} has **bold words** and a [link](https://oddava.me/${index}). ${'Lorem ipsum dolor sit amet. '.repeat(8)}`;

	it('packs paragraphs under the text and caption limits without breaking tags', () => {
		const markdown = Array.from({ length: 40 }, (_, index) => paragraph(index)).join('\n\n');
		const messages = packBlocks(markdownToBlocks(markdown), (index) =>
			index === 0 ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT,
		);
		expect(messages.length).toBeGreaterThan(2);
		messages.forEach((runs, index) => {
			const rendered = renderRuns(runs);
			expect(rendered.length).toBeLessThanOrEqual(index === 0 ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT);
			expect(balanced(rendered.html)).toBe(true);
			expect(rendered.plain.startsWith('Paragraph')).toBe(true);
		});
		const all = messages.map((runs) => renderRuns(runs).plain).join('\n\n');
		expect(all).toContain('Paragraph 39');
	});

	it('cuts one huge paragraph at a sentence and keeps marks on both sides', () => {
		const huge = `> ${'A quoted sentence with **bold** goes here. '.repeat(300).trim()}`;
		const messages = packBlocks(markdownToBlocks(huge), () => TELEGRAM_TEXT_LIMIT);
		expect(messages.length).toBeGreaterThan(2);
		for (const runs of messages) {
			const rendered = renderRuns(runs);
			expect(rendered.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
			expect(rendered.html.startsWith('<blockquote>A quoted')).toBe(true);
			expect(rendered.html.endsWith('here.</blockquote>')).toBe(true);
			expect(balanced(rendered.html)).toBe(true);
		}
	});

	it('stays fast on a paragraph full of markers that never close', () => {
		const started = Date.now();
		markdownToBlocks('*a **b [c '.repeat(8000));
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it('splits a long code block at line breaks into separate pre blocks', () => {
		const code = Array.from({ length: 400 }, (_, index) => `    line_${index} = compute(${index})`).join('\n');
		const messages = packBlocks(markdownToBlocks(`\`\`\`py\n${code}\n\`\`\``), () => TELEGRAM_TEXT_LIMIT);
		expect(messages.length).toBeGreaterThan(1);
		for (const runs of messages) {
			const rendered = renderRuns(runs);
			expect(rendered.html.startsWith('<pre><code class="language-py">    line_')).toBe(true);
			expect(rendered.html.endsWith('</code></pre>')).toBe(true);
		}
	});

	it('keeps each message under the entity budget', () => {
		const markdown = Array.from({ length: 30 }, (_, index) => `**a${index}** *b* \`c\` [d](https://x.dev/${index})`).join('\n\n');
		const messages = packBlocks(markdownToBlocks(markdown), () => TELEGRAM_TEXT_LIMIT, 20);
		expect(messages.length).toBeGreaterThan(1);
		for (const runs of messages) expect(entityCount(runs)).toBeLessThanOrEqual(20);
	});

	it('never cuts a surrogate pair', () => {
		const runs = [{ text: `${'a'.repeat(9)}😀tail`, marks: [] }];
		const [head, tail] = splitRuns(runs, 10);
		expect(renderRuns(head).plain).toBe('a'.repeat(9));
		expect(renderRuns(tail).plain).toBe('😀tail');
	});
});
