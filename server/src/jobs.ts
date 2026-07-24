import { Hono } from 'hono';
import { authMiddleware, type AppEnv } from './auth.js';
import { db } from './db.js';
import { randomUUID } from 'node:crypto';

export const jobs = new Hono<AppEnv>();
jobs.use('*', authMiddleware);

// Minimal queue: jobs are stored in SQLite with a poll API. A real implementation
// would dispatch into ephemeral containers (Fly Machines / Modal) — that part
// is intentionally out of scope; the schema and surface are correct.

jobs.post('/', async (c) => {
	const userId = c.get('userId') as string;
	const body = await c.req.json().catch(() => null) as { task?: unknown } | null;
	if (!body || typeof body.task !== 'string' || body.task.trim().length < 1 || body.task.length > 10_000) {
		return c.json({ error: 'task must contain 1 to 10000 characters' }, 400);
	}
	const id = 'job_' + randomUUID();
	db.prepare(`INSERT INTO jobs (id, user_id, task, status, created_at) VALUES (?, ?, ?, 'queued', ?)`)
		.run(id, userId, body.task, Date.now());
	return c.json({ id });
});

jobs.get('/:id', (c) => {
	const userId = c.get('userId') as string;
	const id = c.req.param('id');
	if (!/^job_[0-9a-f-]{36}$/i.test(id)) { return c.json({ error: 'not found' }, 404); }
	const row = db.prepare(`SELECT * FROM jobs WHERE id = ? AND user_id = ?`).get(id, userId);
	if (!row) { return c.json({ error: 'not found' }, 404); }
	return c.json(row);
});

jobs.get('/', (c) => {
	const userId = c.get('userId') as string;
	const rows = db.prepare(`SELECT id, task, status, created_at, finished_at FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).all(userId);
	return c.json(rows);
});
