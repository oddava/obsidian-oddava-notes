import { describe, expect, it } from 'vitest';
import {
	clampAutoPullMinutes,
	defaultSettings,
	mergeSettings,
	MIN_AUTO_PULL_MINUTES,
} from './settings-data';

describe('mergeSettings', () => {
	it('starts with publish-on-save off, auto-pull on, and the public site', () => {
		const settings = defaultSettings();
		expect(settings.publishOnSave).toBe(false);
		expect(settings.autoPull).toBe(true);
		expect(settings.autoPullIntervalMinutes).toBe(5);
		expect(settings.baseUrl).toBe('https://oddava.me');
		expect(settings.syncFolder).toBe('oddava.me');
		expect(settings.apiToken).toBe('');
		expect(settings.telegramBotToken).toBe('');
		expect(settings.telegramChannel).toBe('@justoddava');
		expect(settings.siteDelete).toBe('ask');
		expect(settings.telegramFormat).toBe('full');
		expect(settings.telegramLinkPreview).toBe('large-below');
		expect(settings.telegramCoverImage).toBe(true);
		expect(settings.telegramSilent).toBe(false);
	});

	it('keeps saved Telegram choices and drops unknown ones', () => {
		const saved = mergeSettings({
			telegramFormat: 'summary',
			telegramLinkPreview: 'small-above',
			telegramCoverImage: false,
			telegramSilent: true,
			telegramChannel: 'https://t.me/someone_else',
		});
		expect(saved).toMatchObject({
			telegramFormat: 'summary',
			telegramLinkPreview: 'small-above',
			telegramCoverImage: false,
			telegramSilent: true,
			telegramChannel: '@someone_else',
		});
		const junk = mergeSettings({ telegramFormat: 'poem', telegramLinkPreview: 'huge', telegramCoverImage: 'yes' });
		expect(junk).toMatchObject({ telegramFormat: 'full', telegramLinkPreview: 'large-below', telegramCoverImage: true });
	});

	it('keeps an explicit auto-pull choice and raises a too-small interval', () => {
		const settings = mergeSettings({
			autoPull: false,
			autoPullIntervalMinutes: 0,
		});
		expect(settings.autoPull).toBe(false);
		expect(mergeSettings({ siteDelete: 'never' }).siteDelete).toBe('never');
		expect(mergeSettings({ siteDelete: 'always' }).siteDelete).toBe('always');
		expect(mergeSettings({ siteDelete: 'later' }).siteDelete).toBe('ask');
		expect(settings.autoPullIntervalMinutes).toBe(MIN_AUTO_PULL_MINUTES);
		expect(clampAutoPullMinutes('12')).toBe(12);
		expect(clampAutoPullMinutes('nope')).toBe(5);
		expect(clampAutoPullMinutes(1.6)).toBe(2);
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
