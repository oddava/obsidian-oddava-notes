export const PUBLISH_DEBOUNCE_MS = 1500;

export interface Debouncer {
	schedule(key: string, task: () => void): void;
	cancel(key: string): void;
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
	const timers = new Map<string, () => void>();
	return {
		schedule(key, task) {
			timers.get(key)?.();
			const cancel = setTimer(() => {
				timers.delete(key);
				task();
			}, waitMs);
			timers.set(key, () => {
				cancel();
				timers.delete(key);
			});
		},
		cancel(key) {
			timers.get(key)?.();
		},
		cancelAll() {
			for (const cancel of timers.values()) cancel();
			timers.clear();
		},
	};
}
