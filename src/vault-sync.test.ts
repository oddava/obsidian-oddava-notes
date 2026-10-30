import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotesClient, toApiError } from './api';
import { findRemoteMoves, pullFromSite } from './sync';
import type { HttpResponse } from './types';
import {
	DELETE_ON_SITE,
	KEEP_ON_SITE,
	bulkDeletePrompt,
	createMoveChain,
	leftFolderPrompt,
	planDeleteBatch,
	planRemoteReconcile,
	planRestore,
	planVaultDelete,
	planVaultRename,
	siteDeletePrompt,
	siteDeleteSetting,
} from './vault-sync';

const folder = 'oddava.me';

describe('planVaultRename', () => {
	it('moves a note that stays inside the sync folder', () => {
		expect(
			planVaultRename(folder, `${folder}/diary/hello.md`, `${folder}/reading/hello.md`),
		).toEqual({
			kind: 'move-on-site',
			fromApiPath: 'diary/hello.md',
			toApiPath: 'reading/hello.md',
		});
	});

	it('treats a move out of the sync folder as a delete, and a move in as a new note', () => {
		expect(planVaultRename(folder, `${folder}/diary/hello.md`, 'archive/hello.md')).toEqual({
			kind: 'left-folder',
			fromApiPath: 'diary/hello.md',
		});
		expect(planVaultRename(folder, 'archive/hello.md', `${folder}/diary/hello.md`)).toEqual({
			kind: 'entered-folder',
			toApiPath: 'diary/hello.md',
		});
		expect(planVaultRename(folder, 'archive/a.md', 'archive/b.md')).toEqual({ kind: 'ignore' });
		expect(
			planVaultRename(folder, `${folder}/diary/hello (site conflict).md`, `${folder}/diary/hello-2.md`),
		).toEqual({ kind: 'ignore' });
	});
});

describe('site delete choice', () => {
	it('asks by default, and can always delete or never touch the site', () => {
		expect(siteDeleteSetting(undefined)).toBe('ask');
		expect(siteDeleteSetting('sometimes')).toBe('ask');
		expect(siteDeleteSetting('always')).toBe('always');
		expect(planVaultDelete(folder, `${folder}/diary/hello.md`, true, 'ask')).toBe('ask');
		expect(planVaultDelete(folder, `${folder}/diary/hello.md`, true, 'always')).toBe('delete');
		expect(planVaultDelete(folder, `${folder}/diary/hello.md`, true, 'never')).toBe('keep');
		expect(planVaultDelete(folder, `${folder}/diary/hello.md`, false, 'always')).toBe('keep');
		expect(siteDeletePrompt('diary/hello.md')).toMatch(/trash/);
		expect(siteDeletePrompt('diary/hello.md')).toMatch(/restored/);
		expect(leftFolderPrompt('diary/hello.md')).toMatch(/left the sync folder/);
		expect(DELETE_ON_SITE).toMatch(/Delete on site/);
		expect(KEEP_ON_SITE).toMatch(/Keep on site/);
	});
});

describe('delete batches and moves out of the folder', () => {
	it('asks for every note when more than one is deleted, even if the setting is always', () => {
		expect(planDeleteBatch({ count: 3, setting: 'always', leftFolder: false })).toBe('ask');
		expect(planDeleteBatch({ count: 2, setting: 'never', leftFolder: false })).toBe('ask');
		expect(bulkDeletePrompt(3)).toMatch(/Delete 3 notes/);
		expect(bulkDeletePrompt(3)).toMatch(/trash/);
	});

	it('does not apply always when a single note leaves the sync folder', () => {
		expect(planDeleteBatch({ count: 1, setting: 'always', leftFolder: true })).toBe('ask');
		expect(planDeleteBatch({ count: 1, setting: 'ask', leftFolder: true })).toBe('ask');
		expect(planDeleteBatch({ count: 1, setting: 'never', leftFolder: true })).toBe('keep');
		expect(planDeleteBatch({ count: 1, setting: 'always', leftFolder: false })).toBe('delete');
		expect(planDeleteBatch({ count: 1, setting: 'never', leftFolder: false })).toBe('keep');
	});
});

describe('restore versus local edits', () => {
	it('writes the restored note only when the vault file is missing or unchanged', () => {
		expect(planRestore({ localExists: false })).toBe('write-restored');
		expect(
			planRestore({ localExists: true, localFingerprint: 'abc', syncedFingerprint: 'abc' }),
		).toBe('write-restored');
		expect(
			planRestore({ localExists: true, localFingerprint: 'edited', syncedFingerprint: 'abc' }),
		).toBe('keep-local');
		expect(planRestore({ localExists: true, localFingerprint: 'edited' })).toBe('keep-local');
	});
});

describe('rename chain', () => {
	it('sends A to B, then B to C, using the revision from the first move', async () => {
		const calls: [string, string, string][] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chain = createMoveChain();
		const first = chain.enqueue('a.md', 'b.md', 'r1', async (from, to, revision) => {
			calls.push([from, to, revision]);
			await gate;
			return 'r2';
		});
		expect(chain.has('b.md')).toBe(true);
		const second = chain.enqueue('b.md', 'c.md', undefined, async (from, to, revision) => {
			calls.push([from, to, revision]);
			return 'r3';
		});
		expect(calls).toEqual([]);
		release();
		await first;
		await second;
		expect(calls).toEqual([
			['a.md', 'b.md', 'r1'],
			['b.md', 'c.md', 'r2'],
		]);
	});
});

describe('vault events wait for layout', () => {
	it('registers rename and delete inside onLayoutReady', () => {
		const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
		const ready = source.indexOf('onLayoutReady');
		const rename = source.indexOf("vault.on('rename'");
		const deleted = source.indexOf("vault.on('delete'");
		expect(ready).toBeGreaterThan(-1);
		expect(rename).toBeGreaterThan(ready);
		expect(deleted).toBeGreaterThan(ready);
		expect(source).toMatch(/if \(!this\.alive \|\| !this\.vaultReady\) return/);
	});
});

describe('pull and the trash', () => {
	it('does not download a note that is only in the deleted list, or also listed as live', async () => {
		const seen: string[] = [];
		const result = await pullFromSite(
			{
				get: async (path: string) => {
					if (path !== 'diary/kept.md') throw new Error(`should not fetch ${path}`);
					return {
						path,
						title: 'kept',
						updated: '2026-10-30T00:00:00.000Z',
						revision: 'r2',
						content: '# kept\n',
					};
				},
			} as unknown as NotesClient,
			(apiPath) => {
				seen.push(apiPath);
				return { vaultPath: `${folder}/${apiPath}`, exists: false, siblingNames: [] };
			},
			{
				notes: [
					{
						path: 'diary/hello.md',
						title: 'hello',
						updated: '2026-10-30T00:00:00.000Z',
						revision: 'r1',
					},
					{
						path: 'diary/kept.md',
						title: 'kept',
						updated: '2026-10-30T00:00:00.000Z',
						revision: 'r2',
					},
				],
				deleted: [
					{
						path: 'diary/hello.md',
						title: 'hello',
						updated: '2026-10-30T00:00:00.000Z',
						revision: 'r9',
						deletedAt: '2026-10-30T01:00:00.000Z',
					},
					{
						path: 'diary/old.md',
						title: 'old',
						updated: '2026-10-01T00:00:00.000Z',
						revision: 'r8',
						deletedAt: '2026-10-30T01:00:00.000Z',
					},
				],
			},
		);
		expect(seen).toEqual(['diary/kept.md']);
		expect(result.downloaded.map((note) => note.apiPath)).toEqual(['diary/kept.md']);
		expect(result.deletedPaths).toEqual(['diary/hello.md', 'diary/old.md']);
		expect(planRemoteReconcile(['diary/hello.md', 'diary/kept.md', 'diary/moved.md'], ['diary/kept.md'], ['diary/hello.md'])).toEqual({
			probe: ['diary/moved.md'],
			gone: ['diary/hello.md'],
		});
	});

	it('follows a moved response to the new path and records a trashed probe', async () => {
		const client = {
			get: async (path: string) => {
				if (path === 'diary/hello.md') {
					throw toApiError({
						status: 409,
						headers: {},
						body: {
							code: 'moved',
							location: 'reading/hello.md',
							error: 'That note now lives at a different path.',
							note: {
								path: 'reading/hello.md',
								title: 'hello',
								updated: '2026-10-30T00:00:00.000Z',
								revision: 'r4',
							},
						},
					});
				}
				if (path === 'diary/gone.md') {
					throw toApiError({
						status: 410,
						headers: {},
						body: {
							code: 'gone',
							error: 'This note was removed.',
							note: {
								path: 'diary/gone.md',
								title: 'gone',
								updated: '2026-10-30T00:00:00.000Z',
								revision: 'r5',
								content: '# gone\n',
							},
						},
					});
				}
				throw new Error(`unexpected ${path}`);
			},
		} as unknown as NotesClient;
		const recon = await findRemoteMoves(
			client,
			['diary/hello.md', 'diary/gone.md'],
			[],
			[],
		);
		expect(recon.moves).toEqual([
			{ fromApiPath: 'diary/hello.md', toApiPath: 'reading/hello.md', revision: 'r4' },
		]);
		expect(recon.gone).toEqual(['diary/gone.md']);
		expect(recon.stoppedEarly).toBeUndefined();
	});
});

describe('moved, gone, and deleted notices', () => {
	it('names the new path and the trash instead of a bare status', () => {
		const moved = toApiError({
			status: 409,
			headers: {},
			body: { code: 'moved', location: 'reading/hello.md', error: 'nope' },
		});
		expect(moved.location).toBe('reading/hello.md');
		expect(moved.message).toMatch(/reading\/hello\.md/);
		expect(moved.message).not.toMatch(/HTTP 409/);

		const gone = toApiError({
			status: 410,
			headers: {},
			body: { code: 'gone', error: 'nope' },
		});
		expect(gone.message).toMatch(/trash/);
		expect(gone.message).toMatch(/restored/);
		expect(gone.message).not.toMatch(/HTTP 410/);

		const deleted = toApiError({
			status: 409,
			headers: {},
			body: { code: 'deleted', error: 'nope' },
		});
		expect(deleted.message).toMatch(/Restore/);
		expect(deleted.message).not.toMatch(/HTTP 409/);
	});
});

describe('notes client move and delete', () => {
	it('posts the move with the revision and deletes with DELETE', async () => {
		const seen: { method: string; url: string; body?: string }[] = [];
		const http = async (request: { method: string; url: string; body?: string }): Promise<HttpResponse> => {
			seen.push(request);
			if (request.method === 'DELETE') {
				return {
					status: 200,
					headers: {},
					body: {
						note: {
							path: 'diary/hello.md',
							title: 'hello',
							updated: '2026-10-30T00:00:00.000Z',
							revision: 'r4',
							deletedAt: '2026-10-30T01:00:00.000Z',
						},
					},
				};
			}
			if (request.url.endsWith('/restore')) {
				return {
					status: 200,
					headers: {},
					body: {
						note: {
							path: 'diary/hello.md',
							title: 'hello',
							updated: '2026-10-30T00:00:00.000Z',
							revision: 'r5',
							content: '# hello\n',
						},
					},
				};
			}
			return {
				status: 200,
				headers: {},
				body: {
					from: 'diary/hello.md',
					note: {
						path: 'reading/hello.md',
						title: 'hello',
						updated: '2026-10-30T00:00:00.000Z',
						revision: 'r3',
						content: '# hello\n',
					},
				},
			};
		};
		const client = new NotesClient(http, 'https://oddava.me', 'notes-api-token');
		const moved = await client.move('diary/hello.md', 'reading/hello.md', 'r2');
		expect(moved.path).toBe('reading/hello.md');
		expect(moved.revision).toBe('r3');
		expect(seen[0]?.url).toBe('https://oddava.me/api/notes/move');
		expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
			from: 'diary/hello.md',
			to: 'reading/hello.md',
			revision: 'r2',
		});
		const trashed = await client.remove('diary/hello.md', 'r3');
		expect(trashed.deletedAt).toBe('2026-10-30T01:00:00.000Z');
		expect(seen[1]?.method).toBe('DELETE');
		expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({ revision: 'r3' });
		const restored = await client.restore('diary/hello.md', 'r4');
		expect(restored.revision).toBe('r5');
		expect(seen[2]?.url).toBe('https://oddava.me/api/notes/restore');
	});

	it('reads the deleted array and tolerates an older list that omits it', async () => {
		const bodies = [
			{
				notes: [
					{
						path: 'diary/hello.md',
						title: 'hello',
						updated: '2026-10-30T00:00:00.000Z',
						revision: 'r1',
					},
				],
				deleted: [
					{
						path: 'diary/old.md',
						title: 'old',
						updated: '2026-10-01T00:00:00.000Z',
						revision: 'r0',
						deletedAt: '2026-10-30T01:00:00.000Z',
					},
				],
			},
			{
				notes: [
					{
						path: 'diary/hello.md',
						title: 'hello',
						updated: '2026-10-30T00:00:00.000Z',
						revision: 'r1',
					},
				],
			},
		];
		let index = 0;
		const client = new NotesClient(async () => {
			const body = bodies[index] ?? bodies[0];
			index += 1;
			return { status: 200, headers: {}, body };
		}, 'https://oddava.me', 'notes-api-token');
		const garden = await client.listGarden();
		expect(garden.deleted[0]?.path).toBe('diary/old.md');
		expect((await client.listGarden()).deleted).toEqual([]);
	});
});
