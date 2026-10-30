import { normalizeBaseUrl } from './api';
import { clampAutoPullMinutes } from './settings-data';
import { summarizeChangedNotes, type PullResult } from './sync';

/**
 * First automatic pull, after the workspace layout is ready.
 * Long enough for the vault to finish opening, short enough that a fresh
 * launch does not wait for the full interval.
 */
export const AUTO_PULL_START_DELAY_MS = 3_000;

/**
 * Browsers run a timer immediately when the delay is above 2^31-1 ms.
 * Cap there so a huge interval cannot turn into a tight loop.
 */
const MAX_TIMER_MS = 2_147_483_647;

export function autoPullIntervalMs(minutes: number): number {
	const ms = clampAutoPullMinutes(minutes) * 60_000;
	if (!Number.isFinite(ms) || ms > MAX_TIMER_MS) return MAX_TIMER_MS;
	return ms;
}

export function canAutoPull(settings: {
	autoPull: boolean;
	baseUrl: string;
	apiToken: string;
}): boolean {
	if (!settings.autoPull) return false;
	if (!normalizeBaseUrl(settings.baseUrl)) return false;
	if (!settings.apiToken.trim()) return false;
	return true;
}

export interface AutoPullNotice {
	/** Null means stay quiet. */
	notice: string | null;
	/** Null clears the remembered error after a pull that did not fail. */
	remember: string | null;
}

/**
 * Automatic pulls announce downloads and conflict copies, and a failure only
 * when that failure is new. The same offline error on the next interval is quiet.
 * A later pull with no error forgets it, so a new outage can be announced once.
 */
export function quietAutoPullNotice(
	previousError: string | null,
	outcome: { changed: string | null; error: string | null },
): AutoPullNotice {
	const error = outcome.error?.trim() ? outcome.error : null;
	const announceError = error && error !== previousError ? error : null;
	const parts = [outcome.changed, announceError].filter(
		(part): part is string => part !== null && part.length > 0,
	);
	return {
		notice: parts.length > 0 ? parts.join(' ') : null,
		remember: error,
	};
}

export function noticeForAutoPull(previousError: string | null, result: PullResult): AutoPullNotice {
	return quietAutoPullNotice(previousError, {
		changed: summarizeChangedNotes(result),
		error: result.stoppedEarly ?? null,
	});
}

export interface TimerHandle {
	cancel(): void;
}

export interface AutoPullTimers {
	setTimeout(callback: () => void, ms: number): TimerHandle;
	setInterval(callback: () => void, ms: number): TimerHandle;
}

export interface AutoPullSchedule {
	/** Call once the workspace layout is ready. */
	arm(): void;
	/** Restart timers after the toggle or the interval changes. */
	reconfigure(): void;
	/** Cancel pending work. Call on unload. */
	stop(): void;
}

export function createAutoPullSchedule(options: {
	enabled: () => boolean;
	intervalMinutes: () => number;
	pull: () => void;
	timers: AutoPullTimers;
	startDelayMs?: number;
}): AutoPullSchedule {
	let stopped = false;
	let armed = false;
	let initial: TimerHandle | null = null;
	let interval: TimerHandle | null = null;
	const startDelayMs = options.startDelayMs ?? AUTO_PULL_START_DELAY_MS;

	function cancelTimers(): void {
		initial?.cancel();
		interval?.cancel();
		initial = null;
		interval = null;
	}

	function apply(includeInitial: boolean): void {
		cancelTimers();
		if (stopped || !armed || !options.enabled()) return;
		if (includeInitial) {
			const slot: { handle: TimerHandle | null } = { handle: null };
			slot.handle = options.timers.setTimeout(() => {
				if (initial === slot.handle) initial = null;
				options.pull();
			}, startDelayMs);
			initial = slot.handle;
		}
		interval = options.timers.setInterval(() => {
			options.pull();
		}, autoPullIntervalMs(options.intervalMinutes()));
	}

	return {
		arm() {
			if (stopped || armed) return;
			armed = true;
			apply(true);
		},
		reconfigure() {
			if (stopped) return;
			const pendingInitial = initial !== null;
			const wasActive = pendingInitial || interval !== null;
			const startSoon = armed && options.enabled() && (!wasActive || pendingInitial);
			apply(startSoon);
		},
		stop() {
			stopped = true;
			armed = false;
			cancelTimers();
		},
	};
}

export type PullSource = 'manual' | 'auto';

/**
 * One pull at a time. An automatic pull that arrives while one is running is
 * skipped (the interval will try again). A manual pull waits, then runs, so
 * the command still does what it was asked to do.
 */
export function createPullGate(): {
	run(source: PullSource, task: () => Promise<void>): Promise<'ran' | 'skipped'>;
} {
	let current: Promise<void> | null = null;

	return {
		async run(source, task) {
			if (current) {
				if (source === 'auto') return 'skipped';
				const inflight = current;
				await inflight;
				return this.run(source, task);
			}

			let release: () => void = () => {};
			const done = new Promise<void>((resolve) => {
				release = resolve;
			});
			current = done;
			try {
				await task();
				return 'ran';
			} finally {
				current = null;
				release();
			}
		},
	};
}
