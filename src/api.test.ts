import { describe, expect, it } from 'vitest';
import { NotesClient, normalizeBaseUrl, noteResourceUrl, toApiError } from './api';
import type { HttpRequest, HttpResponse } from './types';

const token = 'notes-api-token';

describe('normalizeBaseUrl', () => {
	it('keeps an origin and rejects paths, credentials, and other protocols', () => {
		expect(normalizeBaseUrl('https://oddava.me/')).toBe('https://oddava.me');
		expect(normalizeBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
		expect(normalizeBaseUrl('https://oddava.me/api')).toBeNull();
		expect(normalizeBaseUrl('https://user:token@oddava.me')).toBeNull();
		expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
	});
});

describe('noteResourceUrl', () => {
	it('encodes each segment and leaves the slashes', () => {
		expect(noteResourceUrl('https://oddava.me', 'diary/hello.md')).toBe(
			'https://oddava.me/api/notes/diary/hello.md',
		);
	});
});

describe('NotesClient', () => {
	it('sends the bearer token in the header and not in the URL or the error text', async () => {
		const seen: HttpRequest[] = [];
		const http = async (request: HttpRequest): Promise<HttpResponse> => {
			seen.push(request);
			return {
				status: 401,
				headers: {},
				body: { code: 'unauthorized', error: `leaked ${token}` },
			};
		};
		const client = new NotesClient(http, 'https://oddava.me/', token);
		await expect(client.list()).rejects.toThrow(/token was rejected/i);
		expect(seen[0]?.url).toBe('https://oddava.me/api/notes');
		expect(seen[0]?.url).not.toContain(token);
		expect(seen[0]?.headers.Authorization).toBe(`Bearer ${token}`);
		try {
			await client.list();
		} catch (error) {
			expect(error instanceof Error ? error.message : '').not.toContain(token);
		}
	});

	it('puts the revision on update and leaves it off create', async () => {
		const seen: HttpRequest[] = [];
		const note = {
			path: 'diary/hello.md',
			title: 'hello',
			updated: '2026-10-29T18:00:00.000Z',
			revision: 'r2',
			content: '# hello\n',
		};
		const http = async (request: HttpRequest): Promise<HttpResponse> => {
			seen.push(request);
			return { status: request.method === 'POST' ? 201 : 200, headers: {}, body: { note } };
		};
		const client = new NotesClient(http, 'https://oddava.me', token);
		await client.create('diary/hello.md', '# hello\n');
		await client.update('diary/hello.md', '# hello\n\nmore', 'r1');
		expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
			path: 'diary/hello.md',
			content: '# hello\n',
		});
		expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({
			content: '# hello\n\nmore',
			revision: 'r1',
		});
		expect(seen[1]?.method).toBe('PUT');
		expect(seen[1]?.url).toBe('https://oddava.me/api/notes/diary/hello.md');
	});

	it('refuses a path that would escape the notes collection', async () => {
		const http = async (): Promise<HttpResponse> => {
			throw new Error('should not be called');
		};
		const client = new NotesClient(http, 'https://oddava.me', token);
		await expect(client.get('../secret.md')).rejects.toThrow(/will not write|not a note/i);
	});

	it('reads retry-after without trusting a free-text error body', () => {
		const error = toApiError({
			status: 429,
			headers: { 'Retry-After': '30' },
			body: { code: 'rate_limited', error: token },
		});
		expect(error.retryAfter).toBe('30');
		expect(error.message).toMatch(/120 per minute/);
		expect(error.message).not.toContain(token);
	});
});
