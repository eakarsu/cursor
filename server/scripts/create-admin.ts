import { createHash } from 'node:crypto';
import { db } from '../src/db.js';
import { hashPassword } from '../src/password.js';

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
if (!email || !email.includes('@')) throw new Error('ADMIN_EMAIL is required');
if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters');

const id = `local_${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
db.prepare(`
	INSERT INTO users (id,email,github_id,password_hash,created_at,plan)
	VALUES (?, ?, NULL, ?, ?, 'free')
	ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash
`).run(id, email, hashPassword(password), Date.now());
console.log(`Provisioned local administrator ${email}`);
db.close();
