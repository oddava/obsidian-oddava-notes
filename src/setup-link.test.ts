import { describe, expect, it } from 'vitest';
import {
	buildSetupLink,
	parseSetupLink,
	SETUP_ACTION,
	SETUP_LINK_COPIED,
} from './setup-link';

const token = 'abc123def456';

describe('setup links', () => {
	it('builds an obsidian protocol link and parses it back', () => {
		const built = buildSetupLink({
			apiToken: token,
			baseUrl: 'https://oddava.me/',
			syncFolder: 'oddava.me/',
		});
		expect(built.ok).toBe(true);
		if (!built.ok || !built.link) return;
		expect(built.link.startsWith(`obsidian://${SETUP_ACTION}?`)).toBe(true);
		expect(built.link).not.toMatch(/^obsidian:\/\/v/);

		const parsed = parseSetupLink(built.link);
		expect(parsed).toEqual({
			ok: true,
			settings: {
				baseUrl: 'https://oddava.me',
				apiToken: token,
				syncFolder: 'oddava.me',
			},
		});
	});

	it('treats url and folder as optional and requires a token', () => {
		expect(parseSetupLink({ token, action: SETUP_ACTION })).toEqual({
			ok: true,
			settings: {
				baseUrl: 'https://oddava.me',
				apiToken: token,
				syncFolder: 'oddava.me',
			},
		});
		expect(parseSetupLink(`obsidian://${SETUP_ACTION}?token=${token}`)).toMatchObject({
			ok: true,
			settings: { apiToken: token, baseUrl: 'https://oddava.me', syncFolder: 'oddava.me' },
		});

		const missing = parseSetupLink({ url: 'https://oddava.me' });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toMatch(/token/i);

		const empty = buildSetupLink({ apiToken: '   ' });
		expect(empty.ok).toBe(false);
	});

	it('keeps a local origin and a nested folder', () => {
		const built = buildSetupLink({
			apiToken: token,
			baseUrl: 'http://127.0.0.1:8787',
			syncFolder: 'notes/garden',
		});
		expect(built.ok).toBe(true);
		if (!built.ok || !built.link) return;
		expect(parseSetupLink(built.link)).toEqual({
			ok: true,
			settings: {
				baseUrl: 'http://127.0.0.1:8787',
				apiToken: token,
				syncFolder: 'notes/garden',
			},
		});
	});

	it('round-trips a token that needs encoding', () => {
		const unusual = 'tok+en/with spaces';
		const built = buildSetupLink({ apiToken: unusual });
		expect(built.ok).toBe(true);
		if (!built.ok || !built.link) return;
		expect(built.link).not.toContain(' ');
		expect(parseSetupLink(built.link)).toMatchObject({
			ok: true,
			settings: { apiToken: unusual },
		});
		expect(parseSetupLink({ token: unusual })).toMatchObject({
			ok: true,
			settings: { apiToken: unusual },
		});
	});

	it('rejects a bad url or folder without repeating the token', () => {
		const secret = 'super-secret-token-value';
		const badUrl = parseSetupLink({
			token: secret,
			url: 'javascript:alert(1)',
		});
		expect(badUrl.ok).toBe(false);
		if (!badUrl.ok) {
			expect(badUrl.reason).toMatch(/site URL/i);
			expect(badUrl.reason).not.toContain(secret);
		}

		const badFolder = parseSetupLink(
			`obsidian://${SETUP_ACTION}?token=${encodeURIComponent(secret)}&folder=../secrets`,
		);
		expect(badFolder.ok).toBe(false);
		if (!badFolder.ok) expect(badFolder.reason).not.toContain(secret);

		const placeholder = parseSetupLink({ token: 'your_notes_api_token' });
		expect(placeholder.ok).toBe(false);
		if (!placeholder.ok) expect(placeholder.reason).not.toContain('your_notes_api_token');
	});

	it('ignores a link for a different action', () => {
		const result = parseSetupLink(`obsidian://open?token=${token}`);
		expect(result.ok).toBe(false);
	});

	it('warns that the copied link contains the token without including one', () => {
		expect(SETUP_LINK_COPIED).toMatch(/token/i);
		expect(SETUP_LINK_COPIED).toMatch(/only to yourself/i);
		expect(SETUP_LINK_COPIED).not.toContain(token);
		expect(SETUP_LINK_COPIED).not.toMatch(/obsidian:\/\//);
	});
});
