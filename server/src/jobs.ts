import { Hono } from 'hono';
import { authMiddleware } from './auth.js';
import { db } from './db.js';

export const jobs = new Hono();
jobs.use('*', authMiddleware);

// Minimal queue: jobs are stored in SQLite with a poll API. A real implementation
// would dispatch into ephemeral containers (Fly Machines / Modal) — that part
// is intentionally out of scope; the schema and surface are correct.

jobs.post('/', async (c) => {
	const userId = c.get('userId') as string;
	const body = await c.req.json() as { task: string };
	const id = 'job_' + crypto.randomUUID();
	db.prepare(`INSERT INTO jobs (id, user_id, task, status, created_at) VALUES (?, ?, ?, 'queued', ?)`)
		.run(id, userId, body.task, Date.now());
	return c.json({ id });
});

jobs.get('/:id', (c) => {
	const userId = c.get('userId') as string;
	const id = c.req.param('id');
	const row = db.prepare(`SELECT * FROM jobs WHERE id = ? AND user_id = ?`).get(id, userId);
	if (!row) { return c.json({ error: 'not found' }, 404); }
	return c.json(row);
});

jobs.get('/', (c) => {
	const userId = c.get('userId') as string;
	const rows = db.prepare(`SELECT id, task, status, created_at, finished_at FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).all(userId);
	return c.json(rows);
});
