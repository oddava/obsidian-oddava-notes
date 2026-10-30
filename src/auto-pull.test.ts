import { describe, expect, it } from 'vitest';
import {
	AUTO_PULL_START_DELAY_MS,
	autoPullIntervalMs,
	canAutoPull,
	createAutoPullSchedule,
	createPullGate,
	noticeForAutoPull,
	quietAutoPullNotice,
	type AutoPullTimers,
	type TimerHandle,
} from './auto-pull';
import { DEFAULT_AUTO_PULL_MINUTES } from './settings-data';
import type { PullResult } from './sync';

function emptyPull(partial: Partial<PullResult> = {}): PullResult {
	return {
		downloaded: [],
		aligned: [],
		conflicts: [],
		skipped: [],
		...partial,
	};
}

function clock() {
	let now = 0;
	let nextId = 1;
	const timers: {
		id: number;
		at: number;
		every: number | null;
		cb: () => void;
		cancelled: boolean;
	}[] = [];
	const delays = { timeout: [] as number[], interval: [] as number[] };

	function schedule(cb: () => void, ms: number, every: number | null): TimerHandle {
		const entry = { id: nextId++, at: now + ms, every, cb, cancelled: false };
		timers.push(entry);
		return {
			cancel() {
				entry.cancelled = true;
			},
		};
	}

	const timersApi: AutoPullTimers = {
		setTimeout(callback, ms) {
			delays.timeout.push(ms);
			return schedule(callback, ms, null);
		},
		setInterval(callback, ms) {
			delays.interval.push(ms);
			return schedule(callback, ms, ms);
		},
	};

	return {
		timers: timersApi,
		delays,
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const next = timers
					.filter((timer) => !timer.cancelled && timer.at <= target)
					.sort((a, b) => a.at - b.at || a.id - b.id)[0];
				if (!next) break;
				now = next.at;
				if (next.every === null) next.cancelled = true;
				else next.at += next.every;
				next.cb();
			}
			now = target;
		},
	};
}

describe('auto-pull schedule', () => {
	it('pulls shortly after arm, then on the interval', () => {
		const time = clock();
		const pulls: string[] = [];
		const schedule = createAutoPullSchedule({
			enabled: () => true,
			intervalMinutes: () => DEFAULT_AUTO_PULL_MINUTES,
			pull: () => pulls.push('pull'),
			timers: time.timers,
		});

		time.advance(60 * 60_000);
		expect(pulls).toEqual([]);

		schedule.arm();
		expect(time.delays.timeout).toEqual([AUTO_PULL_START_DELAY_MS]);
		expect(time.delays.interval).toEqual([DEFAULT_AUTO_PULL_MINUTES * 60_000]);

		time.advance(AUTO_PULL_START_DELAY_MS - 1);
		expect(pulls).toEqual([]);
		time.advance(1);
		expect(pulls).toEqual(['pull']);

		time.advance(DEFAULT_AUTO_PULL_MINUTES * 60_000);
		expect(pulls).toEqual(['pull', 'pull']);
		schedule.arm();
		time.advance(AUTO_PULL_START_DELAY_MS);
		expect(pulls).toEqual(['pull', 'pull']);
	});

	it('does not schedule before the layout is ready, and stop cancels the first pull', () => {
		const time = clock();
		let enabled = true;
		const pulls: string[] = [];
		const schedule = createAutoPullSchedule({
			enabled: () => enabled,
			intervalMinutes: () => 5,
			pull: () => pulls.push('pull'),
			timers: time.timers,
		});

		schedule.reconfigure();
		time.advance(AUTO_PULL_START_DELAY_MS);
		expect(pulls).toEqual([]);

		schedule.arm();
		schedule.stop();
		time.advance(60 * 60_000);
		expect(pulls).toEqual([]);

		enabled = true;
		schedule.arm();
		schedule.reconfigure();
		time.advance(60 * 60_000);
		expect(pulls).toEqual([]);
	});

	it('stays idle while auto-pull is off, then pulls shortly after it is turned on', () => {
		const time = clock();
		let enabled = false;
		const pulls: string[] = [];
		const schedule = createAutoPullSchedule({
			enabled: () => enabled,
			intervalMinutes: () => 5,
			pull: () => pulls.push('pull'),
			timers: time.timers,
		});

		schedule.arm();
		time.advance(60 * 60_000);
		expect(pulls).toEqual([]);
		expect(time.delays.timeout).toEqual([]);

		enabled = true;
		schedule.reconfigure();
		time.advance(AUTO_PULL_START_DELAY_MS);
		expect(pulls).toEqual(['pull']);
	});

	it('drops a pending startup pull when auto-pull is turned off', () => {
		const time = clock();
		let enabled = true;
		const pulls: string[] = [];
		const schedule = createAutoPullSchedule({
			enabled: () => enabled,
			intervalMinutes: () => 5,
			pull: () => pulls.push('pull'),
			timers: time.timers,
		});
		schedule.arm();
		time.advance(1_000);
		enabled = false;
		schedule.reconfigure();
		time.advance(60 * 60_000);
		expect(pulls).toEqual([]);
	});

	it('restarts the interval without a second startup pull', () => {
		const time = clock();
		let minutes = 5;
		const pulls: string[] = [];
		const schedule = createAutoPullSchedule({
			enabled: () => true,
			intervalMinutes: () => minutes,
			pull: () => pulls.push('pull'),
			timers: time.timers,
		});
		schedule.arm();
		time.advance(AUTO_PULL_START_DELAY_MS);
		expect(pulls).toEqual(['pull']);

		minutes = 2;
		schedule.reconfigure();
		time.advance(AUTO_PULL_START_DELAY_MS);
		expect(pulls).toEqual(['pull']);
		time.advance(2 * 60_000);
		expect(pulls).toEqual(['pull', 'pull']);
		expect(time.delays.interval.at(-1)).toBe(2 * 60_000);
	});

	it('keeps a single startup pull when the interval changes before it fires', () => {
		const time = clock();
		let minutes = 5;
		const pulls: string[] = [];
		const schedule = createAutoPullSchedule({
			enabled: () => true,
			intervalMinutes: () => minutes,
			pull: () => pulls.push('pull'),
			timers: time.timers,
		});
		schedule.arm();
		time.advance(1_000);
		minutes = 10;
		schedule.reconfigure();
		time.advance(AUTO_PULL_START_DELAY_MS - 1);
		expect(pulls).toEqual([]);
		time.advance(1);
		expect(pulls).toEqual(['pull']);
		time.advance(AUTO_PULL_START_DELAY_MS);
		expect(pulls).toEqual(['pull']);
	});

	it('never schedules a sub-minute or overflowing interval', () => {
		expect(autoPullIntervalMs(0)).toBe(60_000);
		expect(autoPullIntervalMs(0.4)).toBe(60_000);
		expect(autoPullIntervalMs(1e15)).toBe(2_147_483_647);
		expect(autoPullIntervalMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_AUTO_PULL_MINUTES * 60_000);

		const time = clock();
		createAutoPullSchedule({
			enabled: () => true,
			intervalMinutes: () => 0,
			pull: () => {},
			timers: time.timers,
		}).arm();
		expect(time.delays.interval).toEqual([60_000]);
	});
});

describe('pull overlap guard', () => {
	it('skips an automatic pull while one is already running', async () => {
		const gate = createPullGate();
		let release: () => void = () => {};
		const events: string[] = [];
		const first = gate.run('auto', () => {
			events.push('first');
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const skipped = await gate.run('auto', async () => {
			events.push('second');
		});
		expect(skipped).toBe('skipped');
		expect(events).toEqual(['first']);
		release();
		expect(await first).toBe('ran');

		const third = await gate.run('auto', async () => {
			events.push('third');
		});
		expect(third).toBe('ran');
		expect(events).toEqual(['first', 'third']);
	});

	it('runs a manual pull after the in-flight pull, without overlapping it', async () => {
		const gate = createPullGate();
		let release: () => void = () => {};
		const events: string[] = [];
		const auto = gate.run('auto', async () => {
			events.push('auto-start');
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			events.push('auto-end');
		});
		const manual = gate.run('manual', async () => {
			events.push('manual');
		});
		await Promise.resolve();
		expect(events).toEqual(['auto-start']);
		release();
		expect(await auto).toBe('ran');
		expect(await manual).toBe('ran');
		expect(events).toEqual(['auto-start', 'auto-end', 'manual']);
	});

	it('skips an automatic pull that arrives during a manual pull', async () => {
		const gate = createPullGate();
		let release: () => void = () => {};
		let autoRan = false;
		const manual = gate.run('manual', () => new Promise<void>((resolve) => {
			release = resolve;
		}));
		const skipped = await gate.run('auto', async () => {
			autoRan = true;
		});
		expect(skipped).toBe('skipped');
		expect(autoRan).toBe(false);
		release();
		expect(await manual).toBe('ran');
	});
});

describe('quiet auto-pull notices', () => {
	it('stays quiet when nothing changed, including unpublished local edits', () => {
		expect(noticeForAutoPull(null, emptyPull()).notice).toBeNull();
		expect(
			noticeForAutoPull(
				null,
				emptyPull({
					aligned: [{ apiPath: 'diary/hello.md', revision: 'r1', fingerprint: 'abc' }],
				}),
			).notice,
		).toBeNull();
		const skipped = noticeForAutoPull(
			null,
			emptyPull({
				skipped: [{ apiPath: 'diary/hello.md', reason: 'The vault note has unpublished edits.' }],
			}),
		);
		expect(skipped.notice).toBeNull();
		expect(skipped.remember).toBeNull();
	});

	it('announces downloaded notes and conflict copies', () => {
		const updated = noticeForAutoPull(
			null,
			emptyPull({
				downloaded: [
					{
						apiPath: 'diary/hello.md',
						vaultPath: 'oddava.me/diary/hello.md',
						content: '# hello',
						revision: 'r2',
						fingerprint: 'abc',
						reason: 'newer',
					},
					{
						apiPath: 'diary/new.md',
						vaultPath: 'oddava.me/diary/new.md',
						content: '# new',
						revision: 'r1',
						fingerprint: 'def',
						reason: 'new',
					},
				],
				skipped: [{ apiPath: 'diary/draft.md', reason: 'The vault note has unpublished edits.' }],
			}),
		);
		expect(updated.notice).toMatch(/Downloaded 1 new note/);
		expect(updated.notice).toMatch(/Updated 1 note from the site/);
		expect(updated.notice).not.toMatch(/unchanged|up to date|unpublished/i);

		const conflict = noticeForAutoPull(
			null,
			emptyPull({
				conflicts: [
					{
						apiPath: 'diary/hello.md',
						conflictVaultPath: 'oddava.me/diary/hello (site conflict).md',
						remote: {
							path: 'diary/hello.md',
							title: 'Hello',
							updated: '2026-10-30T12:00:00.000Z',
							revision: 'r9',
							content: 'site',
						},
						message: 'saved',
					},
				],
			}),
		);
		expect(conflict.notice).toMatch(/hello \(site conflict\)\.md/);
		expect(conflict.notice).toMatch(/Neither side was overwritten/);
	});

	it('announces an error once, then stays quiet until a pull succeeds', () => {
		const offline = 'The site could not be reached.';
		const first = quietAutoPullNotice(null, { changed: null, error: offline });
		expect(first.notice).toBe(offline);

		const repeat = quietAutoPullNotice(first.remember, { changed: null, error: offline });
		expect(repeat.notice).toBeNull();
		expect(repeat.remember).toBe(offline);

		const recovered = noticeForAutoPull(repeat.remember, emptyPull());
		expect(recovered.notice).toBeNull();
		expect(recovered.remember).toBeNull();

		const again = quietAutoPullNotice(recovered.remember, { changed: null, error: offline });
		expect(again.notice).toBe(offline);
	});

	it('still announces new notes when the same error repeats, and announces a new error', () => {
		const offline = 'The site could not be reached.';
		const limited = 'The site is rate limiting requests (120 per minute). Wait and try again.';
		const withChange = noticeForAutoPull(offline, emptyPull({
			downloaded: [
				{
					apiPath: 'diary/hello.md',
					vaultPath: 'oddava.me/diary/hello.md',
					content: '# hello',
					revision: 'r2',
					fingerprint: 'abc',
					reason: 'new',
				},
			],
			stoppedEarly: offline,
		}));
		expect(withChange.notice).toBe('Downloaded 1 new note.');
		expect(withChange.remember).toBe(offline);

		const changedError = quietAutoPullNotice(offline, { changed: null, error: limited });
		expect(changedError.notice).toBe(limited);
		expect(changedError.remember).toBe(limited);
	});
});

describe('canAutoPull', () => {
	const ready = {
		autoPull: true,
		baseUrl: 'https://oddava.me',
		apiToken: 'real-token',
	};

	it('requires the toggle, a token, and an origin', () => {
		expect(canAutoPull(ready)).toBe(true);
		expect(canAutoPull({ ...ready, autoPull: false })).toBe(false);
		expect(canAutoPull({ ...ready, apiToken: '   ' })).toBe(false);
		expect(canAutoPull({ ...ready, baseUrl: '' })).toBe(false);
		expect(canAutoPull({ ...ready, baseUrl: 'not a url' })).toBe(false);
		expect(canAutoPull({ ...ready, baseUrl: 'http://127.0.0.1:8787' })).toBe(true);
	});
});
