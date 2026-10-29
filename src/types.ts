/** A note in a list response. No Markdown body. */
export interface NoteSummary {
	path: string;
	title: string;
	updated: string;
	revision: string;
}

/** A note from create, fetch, or update. Includes the canonical Markdown. */
export interface NoteRecord extends NoteSummary {
	content: string;
}

export interface HttpRequest {
	method: 'GET' | 'POST' | 'PUT';
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

/**
 * The only HTTP dependency the sync code has.
 * Production uses Obsidian's `requestUrl`. Tests pass a fake.
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;
