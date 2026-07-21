import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db, createUser, getUserByGithub, getUser } from './db.js';
import { verifyPassword } from './password.js';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (jwtSecret.length < 32 || /change|replace|example/i.test(jwtSecret)) {
	throw new Error('JWT_SECRET must be a unique value of at least 32 characters');
}
const SECRET = new TextEncoder().encode(jwtSecret);
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:8787';
const publicUrl = new URL(PUBLIC_URL);
if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) {
	throw new Error('PUBLIC_URL must be an HTTP(S) URL without embedded credentials');
}

export const auth = new Hono();

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function sameValue(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value: unknown): string {
	return String(value).replace(/[&<>"']/g, (char) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[char] as string);
}

async function issueSession(user: { id: string; email: string | null; plan: string }) {
	const token = await new SignJWT({ sub: user.id })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('8h')
		.sign(SECRET);
	db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
	db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
		.run(digest(token), user.id, Date.now(), Date.now() + 8 * 60 * 60 * 1000);
	return { token, user: { id: user.id, email: user.email, plan: user.plan }, plan: user.plan };
}

const localLoginSchema = z.object({
	email: z.string().email().max(255).transform((value) => value.trim().toLowerCase()),
	password: z.string().min(8).max(200),
	tenant: z.string().min(1).max(80).optional(),
	tenantSlug: z.string().min(1).max(80).optional(),
}).strict();

auth.post('/login', async (c) => {
	if (process.env.ALLOW_LOCAL_PASSWORD_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
		return c.json({ error: 'local password login is disabled' }, 404);
	}
	const parsed = localLoginSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: 'valid email and password are required' }, 400);
	const user = db.prepare(`SELECT id,email,plan,password_hash FROM users WHERE email = ?`).get(parsed.data.email) as
		| { id: string; email: string | null; plan: string; password_hash: string | null }
		| undefined;
	if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
		return c.json({ error: 'invalid credentials' }, 401);
	}
	return c.json(await issueSession(user));
});

auth.get('/start', (c) => {
	if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
		return c.text('GitHub OAuth is not configured', 503);
	}
	const state = randomUUID();
	setCookie(c, 'oauth_state', state, {
		httpOnly: true,
		sameSite: 'Lax',
		secure: PUBLIC_URL.startsWith('https://'),
		maxAge: 600,
		path: '/auth',
	});
	const url = new URL('https://github.com/login/oauth/authorize');
	url.searchParams.set('client_id', GITHUB_CLIENT_ID);
	url.searchParams.set('redirect_uri', `${PUBLIC_URL}/auth/callback`);
	url.searchParams.set('scope', 'read:user user:email');
	url.searchParams.set('state', state);
	return c.redirect(url.toString());
});

auth.get('/callback', async (c) => {
	const code = c.req.query('code');
	if (!code) { return c.text('missing code', 400); }
	const expectedState = getCookie(c, 'oauth_state') ?? '';
	const returnedState = c.req.query('state') ?? '';
	deleteCookie(c, 'oauth_state', { path: '/auth' });
	if (!expectedState || !sameValue(expectedState, returnedState)) {
		return c.text('invalid OAuth state', 400);
	}
	const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!tokenRes.ok) { return c.text('OAuth exchange failed', 502); }
	const tokenJson: any = await tokenRes.json();
	const ghToken = tokenJson.access_token;
	if (!ghToken) { return c.text('OAuth exchange failed', 400); }

	const userRes = await fetch('https://api.github.com/user', {
		headers: { authorization: `Bearer ${ghToken}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!userRes.ok) { return c.text('GitHub profile request failed', 502); }
	const ghUser: any = await userRes.json();
	if (!ghUser.id || typeof ghUser.login !== 'string') { return c.text('Invalid GitHub profile', 502); }
	const githubId = String(ghUser.id);
	let user = getUserByGithub(githubId);
	if (!user) {
		user = createUser({ id: 'u_' + githubId, githubId, email: ghUser.email ?? undefined });
	}

	// Issue a one-time exchange code so the CLI/extension can claim a JWT
	const exchangeCode = 'oc_' + randomUUID();
	db.prepare(`DELETE FROM oauth_codes WHERE created_at < ?`).run(Date.now() - 10 * 60 * 1000);
	db.prepare(`INSERT INTO oauth_codes (code, user_id, created_at) VALUES (?, ?, ?)`).run(digest(exchangeCode), user.id, Date.now());
	return c.html(`<html><body style="font-family:sans-serif;padding:2rem;"><h2>Authorized as ${escapeHtml(ghUser.login)}</h2><p>Paste this one-time code into the extension prompt:</p><pre style="font-size:1.2rem;background:#eee;padding:1rem;display:inline-block">${escapeHtml(exchangeCode)}</pre></body></html>`);
});

auth.post('/exchange', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const code = body.code as string;
	if (typeof code !== 'string' || code.length < 10 || code.length > 200) {
		return c.json({ error: 'invalid code' }, 400);
	}
	const codeHash = digest(code);
	const row = db.prepare(`SELECT user_id, created_at FROM oauth_codes WHERE code = ?`).get(codeHash) as any;
	if (!row) { return c.json({ error: 'invalid code' }, 400); }
	if (Date.now() - row.created_at > 10 * 60 * 1000) { return c.json({ error: 'expired' }, 400); }
	db.prepare(`DELETE FROM oauth_codes WHERE code = ?`).run(codeHash);
	const user = getUser(row.user_id);
	if (!user) { return c.json({ error: 'user not found' }, 400); }

	return c.json(await issueSession(user));
});

auth.get('/me', authMiddleware, (c) => {
	const user = getUser((c as any).get('userId'));
	return user ? c.json({ user: { id: user.id, email: user.email, plan: user.plan } }) : c.json({ error: 'user not found' }, 404);
});

export async function authMiddleware(c: any, next: any): Promise<any> {
	const header = c.req.header('authorization') ?? '';
	const m = header.match(/^Bearer (.+)$/);
	if (!m) { return c.json({ error: 'unauthorized' }, 401); }
	try {
		const { payload } = await jwtVerify(m[1], SECRET);
		const session = db.prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ?`).get(digest(m[1])) as any;
		if (!session || session.expires_at <= Date.now() || session.user_id !== payload.sub) {
			return c.json({ error: 'invalid session' }, 401);
		}
		c.set('userId', payload.sub as string);
		await next();
	} catch {
		return c.json({ error: 'invalid token' }, 401);
	}
}
