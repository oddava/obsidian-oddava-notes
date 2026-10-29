import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(
	readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'),
);

if (manifest.isDesktopOnly !== false) {
	console.error('manifest.isDesktopOnly must be false so the plugin loads on mobile.');
	process.exit(1);
}

const forbidden = [
	/require\(["']fs["']\)/,
	/require\(["']path["']\)/,
	/require\(["']http["']\)/,
	/require\(["']https["']\)/,
	/require\(["']electron["']\)/,
	/require\(["']crypto["']\)/,
	/require\(["']node:/,
	/require\(["']child_process["']\)/,
	/\bfetch\s*\(/,
	/\bXMLHttpRequest\b/,
];

for (const pattern of forbidden) {
	if (pattern.test(bundle)) {
		console.error(`main.js contains a forbidden API: ${pattern}`);
		process.exit(1);
	}
}

if (!bundle.includes('requestUrl')) {
	console.error('main.js does not call Obsidian requestUrl.');
	process.exit(1);
}

if (!bundle.includes('require("obsidian")') && !bundle.includes("require('obsidian')")) {
	console.error('main.js does not externalize the obsidian module.');
	process.exit(1);
}

console.log('bundle ok');
