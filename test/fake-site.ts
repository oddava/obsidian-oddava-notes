import { splitFrontmatter } from '../src/frontmatter';
import type { HttpClient, HttpRequest, HttpResponse, NoteRecord, NoteSummary } from '../src/types';

interface StoredNote {
	path: string;
	title: string;
	content: string;
	updated: string;
	revision: string;
	order: number;
}

/**
 * A small stand-in for the notes API. Conflict bodies are summaries only,
 * matching the real 409s, which do not include Markdown.
 */
export class FakeSite {
	readonly requests: HttpRequest[] = [];
	token = 'test-token';
	now = '2026-10-29T18:00:00.000Z';
	/** When set, the next request after this many returns 429. */
	rateLimitAfter: number | null = null;
	private readonly notes = new Map<string, StoredNote>();
	private revision = 0;
	private order = 0;

	readonly http: HttpClient = async (request) => {
		this.requests.push(request);
		if (this.rateLimitAfter !== null && this.requests.length > this.rateLimitAfter) {
			return json(429, { error: 'Too many requests.', code: 'rate_limited' }, {
				'Retry-After': '30',
			});
		}
		const header = request.headers.Authorization ?? request.headers.authorization;
		if (header !== `Bearer ${this.token}`) {
			return json(401, { error: `bad ${this.token}`, code: 'unauthorized' });
		}

		const url = new URL(request.url);
		const rest = url.pathname.replace(/^\/api\/notes\/?/, '');
		if (request.method === 'GET' && rest === '') return this.list();
		if (request.method === 'POST' && rest === '') return this.create(request);
		if (request.method === 'GET' && rest) return this.read(decodePath(rest));
		if (request.method === 'PUT' && rest) return this.update(decodePath(rest), request);
		return json(405, { error: 'Method not allowed.', code: 'method_not_allowed' });
	};

	seed(path: string, content: string): NoteRecord {
		return this.write(path, content, undefined);
	}

	private list(): HttpResponse {
		const notes = [...this.notes.values()]
			.map(summarize)
			.sort((left, right) => left.path.localeCompare(right.path));
		return json(200, { notes });
	}

	private read(path: string): HttpResponse {
		const note = this.notes.get(path);
		if (!note) return json(404, { error: 'Not found.', code: 'not_found' });
		return json(200, { note: record(note) });
	}

	private create(request: HttpRequest): HttpResponse {
		const body = parse(request.body);
		const path = typeof body.path === 'string' ? body.path : '';
		const content = body.content;
		if (typeof content !== 'string') {
			return json(400, { error: 'content must be a string.', code: 'invalid_content' });
		}
		const existing = this.notes.get(path);
		if (existing) {
			return json(409, {
				error: 'A note already exists at that path.',
				code: 'path_exists',
				note: summarize(existing),
			});
		}
		const fileName = path.split('/').pop();
		const taken = [...this.notes.values()].find((note) => note.path.split('/').pop() === fileName);
		if (taken) {
			return json(409, {
				error: 'Slug exists.',
				code: 'slug_exists',
				note: summarize(taken),
			});
		}
		return json(201, { note: this.write(path, content, undefined) });
	}

	private update(path: string, request: HttpRequest): HttpResponse {
		const current = this.notes.get(path);
		if (!current) return json(404, { error: 'Not found.', code: 'not_found' });
		const body = parse(request.body);
		if (typeof body.content !== 'string') {
			return json(400, { error: 'content must be a string.', code: 'invalid_content' });
		}
		if (typeof body.revision === 'string' && body.revision !== current.revision) {
			return json(409, {
				error: 'This note changed since you last read it.',
				code: 'revision_conflict',
				note: summarize(current),
			});
		}
		return json(200, { note: this.write(path, body.content, current.order) });
	}

	private write(path: string, content: string, order: number | undefined): NoteRecord {
		this.revision += 1;
		const nextOrder = order ?? this.order++;
		const updated = this.now;
		const stored: StoredNote = {
			path,
			title: titleFrom(content, path),
			content: canonicalize(content, updated, nextOrder),
			updated,
			revision: `r${this.revision}`,
			order: nextOrder,
		};
		this.notes.set(path, stored);
		return record(stored);
	}
}

function canonicalize(content: string, updated: string, order: number): string {
	const body = splitFrontmatter(content).body.trim();
	return `---\norder: ${order}\nupdated: ${updated}\n---\n\n${body}\n`;
}

function titleFrom(content: string, path: string): string {
	const body = splitFrontmatter(content).body;
	const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;
	return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function summarize(note: StoredNote): NoteSummary {
	return {
		path: note.path,
		title: note.title,
		updated: note.updated,
		revision: note.revision,
	};
}

function record(note: StoredNote): NoteRecord {
	return { ...summarize(note), content: note.content };
}

function parse(body: string | undefined): Record<string, unknown> {
	if (!body) return {};
	const parsed: unknown = JSON.parse(body);
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function decodePath(value: string): string {
	return value
		.split('/')
		.map((segment) => decodeURIComponent(segment))
		.join('/');
}

function json(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): HttpResponse {
	return { status, headers, body };
}
