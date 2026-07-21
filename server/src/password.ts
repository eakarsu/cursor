import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const derived = scryptSync(password, salt, 64);
	return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, encoded: string | null | undefined): boolean {
	if (!encoded) return false;
	const [algorithm, saltText, hashText] = encoded.split('$');
	if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
	try {
		const salt = Buffer.from(saltText, 'base64');
		const expected = Buffer.from(hashText, 'base64');
		const actual = scryptSync(password, salt, expected.length);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}
