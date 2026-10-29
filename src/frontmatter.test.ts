import { describe, expect, it } from 'vitest';
import { isLocalNewer, isRemoteNewer, noteBodiesMatch, readUpdated } from './frontmatter';

describe('frontmatter', () => {
	it('reads updated and ignores it when comparing the writing', () => {
		const local = '# hello\r\n\r\nstill learning.';
		const remote = `---\norder: 0\nupdated: "2026-10-29T18:00:00.000Z"\n---\n\n# hello\n\nstill learning.\n`;
		expect(readUpdated(remote)).toBe('2026-10-29T18:00:00.000Z');
		expect(readUpdated(local)).toBeUndefined();
		expect(noteBodiesMatch(local, remote)).toBe(true);
		expect(noteBodiesMatch(local, `${remote}\nmore`)).toBe(false);
	});

	it('compares timestamps only when both exist', () => {
		expect(isRemoteNewer('2026-10-30T00:00:00.000Z', '2026-10-29T00:00:00.000Z')).toBe(true);
		expect(isLocalNewer('2026-10-30T00:00:00.000Z', '2026-10-29T00:00:00.000Z')).toBe(true);
		expect(isRemoteNewer('2026-10-29T00:00:00.000Z', undefined)).toBe(false);
		expect(isLocalNewer(undefined, '2026-10-29T00:00:00.000Z')).toBe(false);
	});
});
