import { Hono } from 'hono';
import { authMiddleware, type AppEnv } from './auth.js';
import { db } from './db.js';

export const sync = new Hono<AppEnv>();
sync.use('*', authMiddleware);

sync.post('/memory', async (c) => {
	const userId = c.get('userId') as string;
	const body = await c.req.json().catch(() => null) as { workspace?: unknown; files?: unknown } | null;
	if (!body || typeof body.workspace !== 'string' || body.workspace.length < 1 || body.workspace.length > 200 || !body.files || typeof body.files !== 'object' || Array.isArray(body.files)) {
		return c.json({ error: 'invalid workspace or files' }, 400);
	}
	const entries = Object.entries(body.files as Record<string, unknown>);
	if (entries.length > 100) { return c.json({ error: 'at most 100 files are accepted per request' }, 413); }
	let totalBytes = 0;
	for (const [rel, content] of entries) {
		if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).{1,500}$/.test(rel) || typeof content !== 'string') {
			return c.json({ error: 'invalid relative path or content' }, 400);
		}
		totalBytes += Buffer.byteLength(content);
	}
	if (totalBytes > 1_000_000) { return c.json({ error: 'file content is too large' }, 413); }
	const stmt = db.prepare(`
		INSERT INTO memory_files (user_id, workspace, rel_path, content, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (user_id, workspace, rel_path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
	`);
	const now = Date.now();
	for (const [rel, content] of entries as Array<[string, string]>) {
		stmt.run(userId, body.workspace, rel, content, now);
	}
	return c.json({ ok: true, count: entries.length });
});

sync.get('/memory', (c) => {
	const userId = c.get('userId') as string;
	const workspace = c.req.query('workspace');
	if (!workspace || workspace.length > 200) { return c.json({ error: 'workspace required' }, 400); }
	const rows = db.prepare(`SELECT rel_path, content FROM memory_files WHERE user_id = ? AND workspace = ?`).all(userId, workspace) as any[];
	const files: Record<string, string> = {};
	for (const r of rows) { files[r.rel_path] = r.content; }
	return c.json({ files });
});
