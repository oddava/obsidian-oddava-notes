import { NotesApiError } from './errors';
import { failureMessage } from './messages';
import { parseApiPath } from './paths';
import type { HttpClient, HttpResponse, NoteRecord, NoteSummary } from './types';

/** Same cap as the notes API: the JSON body, not just the Markdown. */
export const MAX_NOTES_API_BYTES = 1024 * 1024;

const PLACEHOLDER_TOKEN = 'your_notes_api_token';

export function normalizeBaseUrl(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.username || url.password) return null;
	if (url.search || url.hash) return null;
	if (url.pathname !== '/' && url.pathname !== '') return null;
	return url.origin;
}

export function notesCollectionUrl(baseUrl: string): string {
	return `${baseUrl}/api/notes`;
}

export function noteResourceUrl(baseUrl: string, apiPath: string): string {
	const encoded = apiPath
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	return `${notesCollectionUrl(baseUrl)}/${encoded}`;
}

export function jsonByteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

export class NotesClient {
	readonly baseUrl: string;
	private readonly token: string;

	constructor(
		private readonly http: HttpClient,
		baseUrl: string,
		token: string,
	) {
		const normalized = normalizeBaseUrl(baseUrl);
		if (!normalized) {
			throw new Error('The site URL is not a valid http(s) origin. Use https://oddava.me.');
		}
		const trimmed = token.trim();
		if (!trimmed) {
			throw new Error('Add the notes API token in settings.');
		}
		if (trimmed === PLACEHOLDER_TOKEN) {
			throw new Error(
				'That token is the example placeholder. Generate a real one and put it in settings.',
			);
		}
		if (trimmed.length > 512) {
			throw new Error('The token is longer than the site will read.');
		}
		this.baseUrl = normalized;
		this.token = trimmed;
	}

	list(): Promise<NoteSummary[]> {
		return this.request('GET', notesCollectionUrl(this.baseUrl), undefined, (body) => {
			if (!isRecord(body) || !Array.isArray(body.notes)) {
				throw new NotesApiError(
					200,
					failureMessage(200, 'invalid_response', undefined, []),
					'invalid_response',
				);
			}
			return body.notes.map((entry) => {
				if (!isNoteSummary(entry)) {
					throw new NotesApiError(
						200,
						failureMessage(200, 'invalid_response', undefined, []),
						'invalid_response',
					);
				}
				return entry;
			});
		});
	}

	async get(apiPath: string): Promise<NoteRecord> {
		const path = this.safePath(apiPath);
		return this.request('GET', noteResourceUrl(this.baseUrl, path), undefined, (body) =>
			readNote(body),
		);
	}

	async create(apiPath: string, content: string): Promise<NoteRecord> {
		const path = this.safePath(apiPath);
		return this.request(
			'POST',
			notesCollectionUrl(this.baseUrl),
			{ path, content },
			(body) => readNote(body),
		);
	}

	async update(apiPath: string, content: string, revision: string | undefined): Promise<NoteRecord> {
		const path = this.safePath(apiPath);
		const payload: { content: string; revision?: string } = { content };
		if (revision) payload.revision = revision;
		return this.request('PUT', noteResourceUrl(this.baseUrl, path), payload, (body) =>
			readNote(body),
		);
	}

	private safePath(apiPath: string): string {
		const parsed = parseApiPath(apiPath);
		if (!parsed.ok) throw new Error(parsed.reason);
		return parsed.apiPath;
	}

	private async request<T>(
		method: 'GET' | 'POST' | 'PUT',
		url: string,
		payload: unknown,
		read: (body: unknown) => T,
	): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: 'application/json',
		};
		let body: string | undefined;
		if (payload !== undefined) {
			body = JSON.stringify(payload);
			headers['Content-Type'] = 'application/json';
		}
		const response = await this.http({ method, url, headers, body });
		if (response.status >= 200 && response.status < 300) {
			return read(response.body);
		}
		throw toApiError(response);
	}
}

export function toApiError(response: HttpResponse): NotesApiError {
	const failure = readFailure(response.body);
	const retryAfter = header(response.headers, 'retry-after');
	const code = failure.code ?? (response.status === 401 ? 'unauthorized' : undefined);
	return new NotesApiError(
		response.status,
		failureMessage(response.status, code, retryAfter, failure.fields),
		code,
		failure.note,
		retryAfter,
	);
}

function readNote(body: unknown): NoteRecord {
	if (!isRecord(body) || !isNoteRecord(body.note)) {
		throw new NotesApiError(
			200,
			failureMessage(200, 'invalid_response', undefined, []),
			'invalid_response',
		);
	}
	return body.note;
}

function readFailure(body: unknown): { code?: string; note?: NoteSummary; fields: string[] } {
	if (!isRecord(body)) return { fields: [] };
	const code = typeof body.code === 'string' ? body.code : undefined;
	const note = isNoteSummary(body.note) ? body.note : undefined;
	const fields: string[] = [];
	if (Array.isArray(body.issues)) {
		for (const issue of body.issues) {
			if (!isRecord(issue) || !Array.isArray(issue.path)) continue;
			const path = issue.path.filter((part): part is string | number =>
				typeof part === 'string' || typeof part === 'number',
			);
			if (path.length > 0) fields.push(path.join('.'));
		}
	}
	return { code, note, fields };
}

function header(headers: Record<string, string>, name: string): string | undefined {
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && value) return value;
	}
	return undefined;
}

function isNoteSummary(value: unknown): value is NoteSummary {
	if (!isRecord(value)) return false;
	return (
		typeof value.path === 'string' &&
		typeof value.title === 'string' &&
		typeof value.updated === 'string' &&
		typeof value.revision === 'string'
	);
}

function isNoteRecord(value: unknown): value is NoteRecord {
	return isRecord(value) && typeof value.content === 'string' && isNoteSummary(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
