import { describe, expect, it } from 'vitest';
import { defaultSettings, mergeSettings } from './settings-data';

describe('mergeSettings', () => {
	it('starts with publish-on-save off and the public site', () => {
		const settings = defaultSettings();
		expect(settings.publishOnSave).toBe(false);
		expect(settings.baseUrl).toBe('https://oddava.me');
		expect(settings.syncFolder).toBe('oddava.me');
		expect(settings.apiToken).toBe('');
	});

	it('keeps a saved token and drops malformed sync memory', () => {
		const settings = mergeSettings({
			apiToken: 'secret-token',
			publishOnSave: 'yes',
			synced: {
				'diary/hello.md': { revision: 'r1', fingerprint: 'abc' },
				bad: { revision: 1 },
			},
			conflictRevisions: { 'diary/hello.md': 'r9', nope: 4 },
		});
		expect(settings.apiToken).toBe('secret-token');
		expect(settings.publishOnSave).toBe(false);
		expect(settings.synced).toEqual({
			'diary/hello.md': { revision: 'r1', fingerprint: 'abc' },
		});
		expect(settings.conflictRevisions).toEqual({ 'diary/hello.md': 'r9' });
	});
});
