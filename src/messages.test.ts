import { describe, expect, it } from 'vitest';
import { NotesApiError } from './errors';
import { explainError, failureMessage, redact } from './messages';

describe('notices', () => {
	it('redacts the bearer token', () => {
		const token = 'super-secret-token';
		const message = redact(`Authorization: Bearer ${token} failed near ${token}`, token);
		expect(message).not.toContain(token);
		expect(message).toContain('[redacted]');
	});

	it('explains a disabled API without copying the response body', () => {
		const error = new NotesApiError(
			503,
			failureMessage(503, 'notes_api_disabled', undefined, []),
			'notes_api_disabled',
		);
		expect(explainError(error)).toMatch(/NOTES_API_TOKEN/);
		expect(explainError(error)).not.toMatch(/super-secret/);
	});
});
