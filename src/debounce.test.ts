import { describe, expect, it } from 'vitest';
import { createDebouncer, PUBLISH_DEBOUNCE_MS } from './debounce';

describe('createDebouncer', () => {
	it('runs only the latest task for a key', () => {
		const timers: { run: () => void; cancelled: boolean }[] = [];
		const debouncer = createDebouncer(PUBLISH_DEBOUNCE_MS, (callback) => {
			const timer = { run: callback, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		});
		const calls: string[] = [];
		debouncer.schedule('a', () => calls.push('first'));
		debouncer.schedule('a', () => calls.push('second'));
		debouncer.schedule('b', () => calls.push('other'));
		for (const timer of timers) {
			if (!timer.cancelled) timer.run();
		}
		expect(calls).toEqual(['second', 'other']);
		expect(PUBLISH_DEBOUNCE_MS).toBe(1500);
	});

	it('moves a pending publish onto the new path', () => {
		const timers: { run: () => void; cancelled: boolean }[] = [];
		const debouncer = createDebouncer(100, (callback) => {
			const timer = { run: callback, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		});
		const calls: string[] = [];
		debouncer.schedule('old.md', () => calls.push('publish'));
		expect(debouncer.reschedule('missing.md', 'new.md')).toBe(false);
		expect(debouncer.reschedule('old.md', 'new.md')).toBe(true);
		for (const timer of timers) {
			if (!timer.cancelled) timer.run();
		}
		expect(calls).toEqual(['publish']);
		expect(timers[0]?.cancelled).toBe(true);
	});

	it('cancelAll drops pending publishes', () => {
		let ran = false;
		const timers: { run: () => void; cancelled: boolean }[] = [];
		const debouncer = createDebouncer(10, (callback) => {
			const timer = { run: callback, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		});
		debouncer.schedule('a', () => {
			ran = true;
		});
		debouncer.cancelAll();
		for (const timer of timers) {
			if (!timer.cancelled) timer.run();
		}
		expect(ran).toBe(false);
	});
});
