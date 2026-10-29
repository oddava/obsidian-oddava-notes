/**
 * A non-cryptographic fingerprint of the vault text at the last sync.
 * It only answers "has this file changed since we last talked to the site?"
 */

export function contentFingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}
