import { Hono } from 'hono';
import { authMiddleware } from './auth.js';
import { db } from './db.js';

export const sync = new Hono();
sync.use('*', authMiddleware);

sync.post('/memory', async (c) => {
	const userId = c.get('userId') as string;
	const body = await c.req.json() as { workspace: string; files: Record<string, string> };
	const stmt = db.prepare(`
		INSERT INTO memory_files (user_id, workspace, rel_path, content, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (user_id, workspace, rel_path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
	`);
	const now = Date.now();
	for (const [rel, content] of Object.entries(body.files)) {
		stmt.run(userId, body.workspace, rel, content, now);
	}
	return c.json({ ok: true, count: Object.keys(body.files).length });
});

sync.get('/memory', (c) => {
	const userId = c.get('userId') as string;
	const workspace = c.req.query('workspace');
	if (!workspace) { return c.json({ error: 'workspace required' }, 400); }
	const rows = db.prepare(`SELECT rel_path, content FROM memory_files WHERE user_id = ? AND workspace = ?`).all(userId, workspace) as any[];
	const files: Record<string, string> = {};
	for (const r of rows) { files[r.rel_path] = r.content; }
	return c.json({ files });
});
