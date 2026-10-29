import type { NoteSummary } from './types';

export class NotesApiError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly note?: NoteSummary;
	readonly retryAfter?: string;

	constructor(
		status: number,
		message: string,
		code?: string,
		note?: NoteSummary,
		retryAfter?: string,
	) {
		super(message);
		this.name = 'NotesApiError';
		this.status = status;
		this.code = code;
		this.note = note;
		this.retryAfter = retryAfter;
	}
}

export function isFatalApiError(error: unknown): boolean {
	if (!(error instanceof NotesApiError)) return false;
	if (error.status === 401 || error.status === 413 || error.status === 503) return true;
	return error.code === 'rate_limited';
}
