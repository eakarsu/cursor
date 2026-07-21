import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

const databasePath = `/private/tmp/cursor-auth-${process.pid}-${randomUUID()}.sqlite`;
process.env.DB_PATH = databasePath;
process.env.JWT_SECRET = 'cursor-test-jwt-secret-with-at-least-32-characters';
process.env.PUBLIC_URL = 'http://127.0.0.1:6199';
process.env.NODE_ENV = 'test';
process.env.ALLOW_LOCAL_PASSWORD_LOGIN = 'true';

const { auth } = await import('./auth.js');
const { db } = await import('./db.js');
const { hashPassword } = await import('./password.js');

const password = 'RuntimeAcceptance123!';
db.prepare(`INSERT INTO users(id,email,password_hash,created_at,plan) VALUES(?,?,?,?,?)`)
	.run('test_admin', 'runtime-admin@example.test', hashPassword(password), Date.now(), 'free');
const app = new Hono();
app.route('/auth', auth);
app.route('/api/auth', auth);

after(() => {
	db.close();
	for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});

test('local acceptance login persists and reloads a session', async () => {
	const login = await app.request('/auth/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ tenant: 'runtime-tenant', email: 'runtime-admin@example.test', password }),
	});
	assert.equal(login.status, 200);
	const body = await login.json() as { token: string; user: { email: string } };
	assert.equal(body.user.email, 'runtime-admin@example.test');

	const me = await app.request('/api/auth/me', { headers: { authorization: `Bearer ${body.token}` } });
	assert.equal(me.status, 200);
	assert.equal((await me.json() as any).user.email, 'runtime-admin@example.test');
});
