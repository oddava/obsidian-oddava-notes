import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'src');

function productionSources(): { name: string; text: string }[] {
	return readdirSync(sourceDir)
		.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
		.map((name) => ({ name, text: readFileSync(join(sourceDir, name), 'utf8') }));
}

describe('mobile safety', () => {
	it('ships as a phone plugin and talks HTTP only through requestUrl', () => {
		const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
			isDesktopOnly: boolean;
			id: string;
		};
		expect(manifest.isDesktopOnly).toBe(false);
		expect(manifest.id).toBe('oddava-notes');

		const http = readFileSync(join(sourceDir, 'obsidian-http.ts'), 'utf8');
		expect(http).toContain('requestUrl');
		expect(http).not.toMatch(/\bfetch\s*\(/);

		const forbidden =
			/from\s+['"](?:node:|fs|path|http|https|crypto|electron|child_process)|require\s*\(\s*['"](?:fs|path|http|https|electron|crypto)/;
		for (const source of productionSources()) {
			expect(source.text, source.name).not.toMatch(forbidden);
			expect(source.text, source.name).not.toMatch(/\bfetch\s*\(/);
			expect(source.text, source.name).not.toMatch(/\bconsole\./);
		}
	});
});
