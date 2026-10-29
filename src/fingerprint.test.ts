import { describe, expect, it } from 'vitest';
import { contentFingerprint } from './fingerprint';

describe('contentFingerprint', () => {
	it('stays the same for the same text and changes when the text changes', () => {
		expect(contentFingerprint('hello')).toBe(contentFingerprint('hello'));
		expect(contentFingerprint('hello')).not.toBe(contentFingerprint('hello!'));
	});
});
