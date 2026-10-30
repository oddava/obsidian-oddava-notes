export const PUBLISH_DEBOUNCE_MS = 1500;

export interface Debouncer {
	schedule(key: string, task: () => void): void;
	cancel(key: string): void;
	/** Move a pending task to a new key. Returns false when nothing was waiting. */
	reschedule(from: string, to: string): boolean;
	cancelAll(): void;
}

/**
 * `setTimer` returns a cancel function. The plugin passes `setTimeout`.
 * Tests pass a fake clock.
 */
export function createDebouncer(
	waitMs: number,
	setTimer: (callback: () => void, ms: number) => () => void,
): Debouncer {
	const timers = new Map<string, { cancel: () => void; task: () => void }>();
	return {
		schedule(key, task) {
			timers.get(key)?.cancel();
			let stop: () => void = () => {};
			const entry = {
				task,
				cancel() {
					stop();
					timers.delete(key);
				},
			};
			stop = setTimer(() => {
				timers.delete(key);
				task();
			}, waitMs);
			timers.set(key, entry);
		},
		cancel(key) {
			timers.get(key)?.cancel();
		},
		reschedule(from, to) {
			const pending = timers.get(from);
			if (!pending) return false;
			const task = pending.task;
			pending.cancel();
			this.schedule(to, task);
			return true;
		},
		cancelAll() {
			for (const timer of timers.values()) timer.cancel();
			timers.clear();
		},
	};
}
