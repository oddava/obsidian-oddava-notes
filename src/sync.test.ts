import { describe, expect, it } from 'vitest';
import { NotesClient } from './api';
import { contentFingerprint } from './fingerprint';
import { publishNote, pullFromSite, summarizePull, type LocalNote } from './sync';
import { FakeSite } from '../test/fake-site';

const folder = 'oddava.me';
const token = 'test-token';

function clientFor(site: FakeSite): NotesClient {
	return new NotesClient(site.http, 'https://oddava.me', token);
}

function local(partial: Partial<LocalNote> & Pick<LocalNote, 'vaultPath'>): LocalNote {
	return {
		exists: false,
		siblingNames: [],
		...partial,
	};
}

describe('publishNote', () => {
	it('creates a note and remembers the revision the site returned', async () => {
		const site = new FakeSite();
		const result = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: '# hello\n\nstill learning.',
			siblingNames: [],
		});
		expect(result.kind).toBe('published');
		if (result.kind !== 'published') return;
		expect(result.created).toBe(true);
		expect(result.revision).toMatch(/^r/);
		expect(result.fingerprint).toBe(contentFingerprint('# hello\n\nstill learning.'));
		expect(site.requests.map((request) => request.method)).toEqual(['POST']);
		expect(result.message).toMatch(/Created diary\/hello.md/);
	});

	it('updates with the stored revision', async () => {
		const site = new FakeSite();
		const created = site.seed('diary/hello.md', '# hello\n');
		const result = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: '# hello\n\nfrom the phone',
			revision: created.revision,
			siblingNames: [],
		});
		expect(result.kind).toBe('published');
		if (result.kind !== 'published') return;
		expect(result.created).toBe(false);
		expect(result.revision).not.toBe(created.revision);
		const update = site.requests.find((request) => request.method === 'PUT');
		expect(JSON.parse(update?.body ?? '{}').revision).toBe(created.revision);
	});

	it('does not overwrite either side when the revision conflicts', async () => {
		const site = new FakeSite();
		const created = site.seed('diary/hello.md', '# hello\n\nvault text');
		site.now = '2026-10-30T12:00:00.000Z';
		const remote = site.seed('diary/hello.md', '# hello\n\nsite text');
		site.requests.length = 0;

		const result = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: '# hello\n\nvault text',
			revision: created.revision,
			siblingNames: [],
		});

		expect(result.kind).toBe('conflict');
		if (result.kind !== 'conflict') return;
		expect(result.conflictVaultPath).toBe(`${folder}/diary/hello (site conflict).md`);
		expect(result.remote.content).toContain('site text');
		expect(result.remote.revision).toBe(remote.revision);
		expect(result.message).toMatch(/Neither|left as they are/i);
		expect(site.requests.map((request) => request.method)).toEqual(['PUT', 'GET']);
		const stored = site.requests.filter((request) => request.method === 'PUT');
		expect(stored).toHaveLength(1);
		expect(JSON.parse(stored[0]?.body ?? '{}').content).toContain('vault text');
	});

	it('adopts the site revision when create finds the same writing', async () => {
		const site = new FakeSite();
		const existing = site.seed('diary/hello.md', '# hello\n\nstill learning.');
		site.requests.length = 0;
		const result = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: '# hello\n\nstill learning.',
			siblingNames: [],
		});
		expect(result.kind).toBe('published');
		if (result.kind !== 'published') return;
		expect(result.adopted).toBe(true);
		expect(result.revision).toBe(existing.revision);
		expect(site.requests.map((request) => request.method)).toEqual(['POST', 'GET']);
	});

	it('saves a conflict when create finds different writing', async () => {
		const site = new FakeSite();
		site.seed('reading/hello.md', '# hello\n\nfrom studio');
		const result = await publishNote(clientFor(site), {
			apiPath: 'reading/hello.md',
			vaultPath: `${folder}/reading/hello.md`,
			content: '# hello\n\nfrom the vault',
			siblingNames: [],
		});
		expect(result.kind).toBe('conflict');
		if (result.kind !== 'conflict') return;
		expect(result.conflictVaultPath).toBe(`${folder}/reading/hello (site conflict).md`);
		expect(site.requests.some((request) => request.method === 'PUT')).toBe(false);
	});

	it('stops when the file name is already used in another folder', async () => {
		const site = new FakeSite();
		site.seed('diary/hello.md', '# hello\n');
		const result = await publishNote(clientFor(site), {
			apiPath: 'reading/hello.md',
			vaultPath: `${folder}/reading/hello.md`,
			content: '# hello\n\nother',
			siblingNames: [],
		});
		expect(result.kind).toBe('error');
		if (result.kind !== 'error') return;
		expect(result.message).toMatch(/diary\/hello.md/);
		expect(result.message).toMatch(/Nothing was overwritten/);
		expect(site.requests.map((request) => request.method)).toEqual(['POST']);
	});

	it('refuses to publish while a conflict file is open, then retries with the site revision', async () => {
		const site = new FakeSite();
		const remote = site.seed('diary/hello.md', '# hello\n\nsite');
		const blocked = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: '# hello\n\nmerged',
			revision: 'r-stale',
			pendingConflictRevision: remote.revision,
			siblingNames: ['hello (site conflict).md'],
		});
		expect(blocked.kind).toBe('blocked');
		expect(site.requests).toHaveLength(0);

		const published = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: '# hello\n\nmerged',
			revision: 'r-stale',
			pendingConflictRevision: remote.revision,
			siblingNames: [],
		});
		expect(published.kind).toBe('published');
		const update = site.requests.find((request) => request.method === 'PUT');
		expect(JSON.parse(update?.body ?? '{}').revision).toBe(remote.revision);
	});

	it('creates again when an update finds the note was removed', async () => {
		const site = new FakeSite();
		const result = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: '# hello\n',
			revision: 'r-missing',
			siblingNames: [],
		});
		expect(result.kind).toBe('published');
		if (result.kind !== 'published') return;
		expect(result.created).toBe(true);
		expect(site.requests.map((request) => request.method)).toEqual(['PUT', 'POST']);
	});

	it('does not call the site when the note is over 1 MB', async () => {
		const site = new FakeSite();
		const result = await publishNote(clientFor(site), {
			apiPath: 'diary/hello.md',
			vaultPath: `${folder}/diary/hello.md`,
			content: 'a'.repeat(1024 * 1024),
			siblingNames: [],
		});
		expect(result.kind).toBe('error');
		expect(site.requests).toHaveLength(0);
	});
});

describe('pullFromSite', () => {
	it('downloads notes that are not in the vault', async () => {
		const site = new FakeSite();
		site.seed('diary/hello.md', '# hello\n\nfrom the site');
		const result = await pullFromSite(clientFor(site), (apiPath) =>
			local({ vaultPath: `${folder}/${apiPath}` }),
		);
		expect(result.downloaded).toHaveLength(1);
		expect(result.downloaded[0]?.reason).toBe('new');
		expect(result.downloaded[0]?.content).toContain('from the site');
		expect(result.downloaded[0]?.vaultPath).toBe(`${folder}/diary/hello.md`);
		expect(summarizePull(result)).toMatch(/Downloaded 1 new note/);
	});

	it('does not fetch a note whose revision and fingerprint still match', async () => {
		const site = new FakeSite();
		const remote = site.seed('diary/hello.md', '# hello\n');
		const content = '# hello\n';
		const result = await pullFromSite(clientFor(site), () =>
			local({
				vaultPath: `${folder}/diary/hello.md`,
				exists: true,
				content,
				revision: remote.revision,
				fingerprint: contentFingerprint(content),
			}),
		);
		expect(result.aligned).toHaveLength(1);
		expect(result.downloaded).toHaveLength(0);
		expect(site.requests.map((request) => request.method)).toEqual(['GET']);
		expect(summarizePull(result)).toMatch(/Already up to date/);
	});

	it('leaves unpublished vault edits in place when the site revision matches', async () => {
		const site = new FakeSite();
		const remote = site.seed('diary/hello.md', '# hello\n');
		const content = '# hello\n\nedited locally';
		const result = await pullFromSite(clientFor(site), () =>
			local({
				vaultPath: `${folder}/diary/hello.md`,
				exists: true,
				content,
				revision: remote.revision,
				fingerprint: contentFingerprint('# hello\n'),
			}),
		);
		expect(result.downloaded).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
		expect(result.skipped[0]?.reason).toMatch(/unpublished/);
		expect(site.requests.map((request) => request.method)).toEqual(['GET']);
	});

	it('downloads a newer site copy when the vault text has not changed', async () => {
		const site = new FakeSite();
		const first = site.seed('diary/hello.md', '# hello\n\nfirst');
		site.now = '2026-10-30T12:00:00.000Z';
		site.seed('diary/hello.md', '# hello\n\nsecond');
		const content = '# hello\n\nfirst';
		const result = await pullFromSite(clientFor(site), () =>
			local({
				vaultPath: `${folder}/diary/hello.md`,
				exists: true,
				content,
				revision: first.revision,
				fingerprint: contentFingerprint(content),
			}),
		);
		expect(result.downloaded).toHaveLength(1);
		expect(result.downloaded[0]?.reason).toBe('newer');
		expect(result.downloaded[0]?.content).toContain('second');
		expect(result.conflicts).toHaveLength(0);
	});

	it('writes a conflict file when both sides changed', async () => {
		const site = new FakeSite();
		const first = site.seed('diary/hello.md', '# hello\n\nfirst');
		site.seed('diary/hello.md', '# hello\n\nsite');
		const content = '# hello\n\nvault';
		const result = await pullFromSite(clientFor(site), () =>
			local({
				vaultPath: `${folder}/diary/hello.md`,
				exists: true,
				content,
				revision: first.revision,
				fingerprint: contentFingerprint('# hello\n\nfirst'),
				siblingNames: [],
			}),
		);
		expect(result.downloaded).toHaveLength(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.conflictVaultPath).toBe(
			`${folder}/diary/hello (site conflict).md`,
		);
		expect(result.conflicts[0]?.remote.content).toContain('site');
		expect(summarizePull(result)).toMatch(/Neither side was overwritten/);
	});

	it('downloads when the site updated time is newer and this device has never synced the note', async () => {
		const site = new FakeSite();
		site.now = '2026-10-30T12:00:00.000Z';
		site.seed('diary/hello.md', '# hello\n\nsite');
		const result = await pullFromSite(clientFor(site), () =>
			local({
				vaultPath: `${folder}/diary/hello.md`,
				exists: true,
				content: `---\nupdated: 2026-10-01T00:00:00.000Z\n---\n\n# hello\n\nvault`,
			}),
		);
		expect(result.downloaded[0]?.reason).toBe('newer');
	});

	it('keeps a newer vault note that has never been synced', async () => {
		const site = new FakeSite();
		site.now = '2026-10-01T00:00:00.000Z';
		site.seed('diary/hello.md', '# hello\n\nsite');
		const result = await pullFromSite(clientFor(site), () =>
			local({
				vaultPath: `${folder}/diary/hello.md`,
				exists: true,
				content: `---\nupdated: 2026-10-30T00:00:00.000Z\n---\n\n# hello\n\nvault`,
			}),
		);
		expect(result.downloaded).toHaveLength(0);
		expect(result.skipped[0]?.reason).toMatch(/newer/);
	});

	it('ignores a site path that would escape the sync folder', async () => {
		const seen: string[] = [];
		const result = await pullFromSite(
			{
				list: async () => [
					{
						path: '../secret.md',
						title: 'secret',
						updated: '2026-10-29T18:00:00.000Z',
						revision: 'r1',
					},
				],
				get: async () => {
					throw new Error('should not fetch');
				},
				create: async () => {
					throw new Error('no');
				},
				update: async () => {
					throw new Error('no');
				},
			} as unknown as NotesClient,
			(apiPath) => {
				seen.push(apiPath);
				return local({ vaultPath: `${folder}/${apiPath}` });
			},
		);
		expect(seen).toEqual([]);
		expect(result.skipped[0]?.apiPath).toBe('../secret.md');
		expect(result.downloaded).toHaveLength(0);
	});

	it('stops the pull when the site rate limits', async () => {
		const site = new FakeSite();
		site.seed('diary/a.md', '# a\n');
		site.seed('diary/b.md', '# b\n');
		site.seed('diary/c.md', '# c\n');
		site.rateLimitAfter = 2;
		const result = await pullFromSite(clientFor(site), (apiPath) =>
			local({ vaultPath: `${folder}/${apiPath}` }),
		);
		expect(result.downloaded.length).toBeGreaterThan(0);
		expect(result.downloaded.length).toBeLessThan(3);
		expect(result.stoppedEarly).toMatch(/rate limit/i);
		expect(summarizePull(result)).toMatch(/Retry after 30/);
	});

	it('reports a disabled API without downloading', async () => {
		const http = async () => ({
			status: 503,
			headers: {},
			body: { code: 'notes_api_disabled', error: 'off' },
		});
		const result = await pullFromSite(new NotesClient(http, 'https://oddava.me', token), () =>
			local({ vaultPath: `${folder}/diary/hello.md` }),
		);
		expect(result.downloaded).toHaveLength(0);
		expect(result.stoppedEarly).toMatch(/NOTES_API_TOKEN/);
	});
});
