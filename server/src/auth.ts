import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { db, createUser, getUserByGithub, getUser } from './db.js';

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-change-me');
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:8787';

export const auth = new Hono();

auth.get('/start', (c) => {
	if (!GITHUB_CLIENT_ID) {
		return c.text('GITHUB_CLIENT_ID not configured', 500);
	}
	const url = new URL('https://github.com/login/oauth/authorize');
	url.searchParams.set('client_id', GITHUB_CLIENT_ID);
	url.searchParams.set('redirect_uri', `${PUBLIC_URL}/auth/callback`);
	url.searchParams.set('scope', 'read:user user:email');
	return c.redirect(url.toString());
});

auth.get('/callback', async (c) => {
	const code = c.req.query('code');
	if (!code) { return c.text('missing code', 400); }
	const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code }),
	});
	const tokenJson: any = await tokenRes.json();
	const ghToken = tokenJson.access_token;
	if (!ghToken) { return c.text('OAuth exchange failed: ' + JSON.stringify(tokenJson), 400); }

	const userRes = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${ghToken}` } });
	const ghUser: any = await userRes.json();
	const githubId = String(ghUser.id);
	let user = getUserByGithub(githubId);
	if (!user) {
		user = createUser({ id: 'u_' + githubId, githubId, email: ghUser.email ?? undefined });
	}

	// Issue a one-time exchange code so the CLI/extension can claim a JWT
	const exchangeCode = 'oc_' + crypto.randomUUID();
	db.prepare(`INSERT INTO oauth_codes (code, user_id, created_at) VALUES (?, ?, ?)`).run(exchangeCode, user.id, Date.now());
	return c.html(`<html><body style="font-family:sans-serif;padding:2rem;"><h2>Authorized as ${ghUser.login}</h2><p>Paste this code into the extension prompt:</p><pre style="font-size:1.2rem;background:#eee;padding:1rem;display:inline-block">${exchangeCode}</pre></body></html>`);
});

auth.post('/exchange', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const code = body.code as string;
	if (!code) { return c.json({ error: 'missing code' }, 400); }
	const row = db.prepare(`SELECT user_id, created_at FROM oauth_codes WHERE code = ?`).get(code) as any;
	if (!row) { return c.json({ error: 'invalid code' }, 400); }
	if (Date.now() - row.created_at > 10 * 60 * 1000) { return c.json({ error: 'expired' }, 400); }
	db.prepare(`DELETE FROM oauth_codes WHERE code = ?`).run(code);
	const user = getUser(row.user_id);
	if (!user) { return c.json({ error: 'user not found' }, 400); }

	const token = await new SignJWT({ sub: user.id })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('30d')
		.sign(SECRET);

	db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
		.run(token, user.id, Date.now(), Date.now() + 30 * 24 * 60 * 60 * 1000);
	return c.json({ token, user: user.email ?? user.id, plan: user.plan });
});

export async function authMiddleware(c: any, next: any): Promise<any> {
	const header = c.req.header('authorization') ?? '';
	const m = header.match(/^Bearer (.+)$/);
	if (!m) { return c.json({ error: 'unauthorized' }, 401); }
	try {
		const { payload } = await jwtVerify(m[1], SECRET);
		c.set('userId', payload.sub as string);
		await next();
	} catch {
		return c.json({ error: 'invalid token' }, 401);
	}
}
