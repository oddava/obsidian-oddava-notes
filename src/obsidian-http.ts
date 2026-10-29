import { requestUrl } from 'obsidian';
import type { HttpClient, HttpResponse } from './types';

/**
 * Mobile and desktop both provide `requestUrl`. `fetch` and Node's HTTP
 * stack are not used: neither is a safe bet on iOS and Android.
 */
export function createObsidianHttp(): HttpClient {
	return async (request) => {
		try {
			const response = await requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				body: request.body,
				throw: false,
			});
			return toHttpResponse(response.status, response.headers, response.text);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'The site could not be reached.';
			throw new Error(redactBearer(message || 'The site could not be reached.'));
		}
	};
}

function toHttpResponse(
	status: number,
	headers: Record<string, string>,
	text: string,
): HttpResponse {
	return {
		status,
		headers,
		body: parseBody(text),
	};
}

function parseBody(text: string): unknown {
	if (!text.trim()) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function redactBearer(message: string): string {
	return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}
