import { describe, expect, it } from 'vitest';
import {
	destinationInSyncFolder,
	hasOpenConflict,
	nextConflictVaultPath,
	parseApiPath,
	pathInsideSyncFolder,
	toApiPath,
	vaultPathForApi,
} from './paths';

const folder = 'oddava.me';

describe('toApiPath', () => {
	it('strips the sync folder and keeps the garden path', () => {
		expect(toApiPath(folder, 'oddava.me/diary/hello.md')).toEqual({
			ok: true,
			apiPath: 'diary/hello.md',
		});
		expect(toApiPath('oddava.me/', 'oddava.me/hello.md')).toEqual({
			ok: true,
			apiPath: 'hello.md',
		});
		expect(toApiPath(folder, 'oddava.me\\reading\\atomic-habits.md')).toEqual({
			ok: true,
			apiPath: 'reading/atomic-habits.md',
		});
	});

	it('rejects paths the site would reject', () => {
		expect(toApiPath(folder, 'oddava.me/Diary/Hello.md').ok).toBe(false);
		expect(toApiPath(folder, 'oddava.me/my_note.md').ok).toBe(false);
		expect(toApiPath(folder, 'oddava.me/../secret.md').ok).toBe(false);
		expect(toApiPath(folder, 'other/hello.md').ok).toBe(false);
		expect(toApiPath(folder, 'oddava.me/picture.png').ok).toBe(false);
		expect(toApiPath('', 'hello.md').ok).toBe(false);
	});

	it('explains a conflict copy instead of publishing it', () => {
		const result = toApiPath(folder, 'oddava.me/diary/hello (site conflict).md');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/conflict copy/i);
	});
});

describe('parseApiPath', () => {
	it('accepts a site path with or without the extension and rejects escapes', () => {
		expect(parseApiPath('diary/hello')).toEqual({ ok: true, apiPath: 'diary/hello.md' });
		expect(parseApiPath('diary/hello.md')).toEqual({ ok: true, apiPath: 'diary/hello.md' });
		expect(parseApiPath('../secret.md').ok).toBe(false);
		expect(parseApiPath('/etc/passwd').ok).toBe(false);
		expect(parseApiPath('diary/../../secret.md').ok).toBe(false);
		expect(() => vaultPathForApi(folder, '../secret.md')).toThrow(/will not write|not a note/i);
	});
});

describe('moving a note into the sync folder', () => {
	it('keeps the vault-relative path and refuses escapes', () => {
		expect(pathInsideSyncFolder('oddava.me', 'oddava.me/diary/hello.md')).toBe(true);
		expect(pathInsideSyncFolder('oddava.me', 'journal/hello.md')).toBe(false);
		expect(destinationInSyncFolder('oddava.me/', 'journal/hello.md')).toBe(
			'oddava.me/journal/hello.md',
		);
		expect(destinationInSyncFolder('oddava.me', 'hello.md')).toBe('oddava.me/hello.md');
		expect(destinationInSyncFolder('oddava.me', 'oddava.me/hello.md')).toBeNull();
		expect(destinationInSyncFolder('oddava.me', '../secret.md')).toBeNull();
	});
});

describe('conflict file names', () => {
	it('picks a free sibling name and recognises copies that are still open', () => {
		const note = 'oddava.me/diary/hello.md';
		expect(nextConflictVaultPath(note, [])).toBe('oddava.me/diary/hello (site conflict).md');
		expect(nextConflictVaultPath(note, ['hello (site conflict).md'])).toBe(
			'oddava.me/diary/hello (site conflict 2).md',
		);
		expect(hasOpenConflict(note, ['hello (site conflict 2).md'])).toBe(true);
		expect(hasOpenConflict(note, ['hello.md'])).toBe(false);
	});
});
