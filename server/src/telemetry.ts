import { Hono } from 'hono';
import { authMiddleware, type AppEnv } from './auth.js';
import { db } from './db.js';

export const telemetry = new Hono<AppEnv>();
telemetry.use('*', authMiddleware);

telemetry.post('/', async (c) => {
	const userId = c.get('userId') as string;
	const body = await c.req.json().catch(() => null) as any;
	if (!body || typeof body.clientId !== 'string' || body.clientId.length < 1 || body.clientId.length > 200 || !Array.isArray(body.events) || body.events.length > 100) {
		return c.json({ error: 'invalid telemetry payload' }, 400);
	}
	const rows: Array<{ ts: number; kind: string; props: string | null }> = [];
	for (const event of body.events) {
		if (!event || !Number.isFinite(event.ts) || typeof event.kind !== 'string' || event.kind.length < 1 || event.kind.length > 100) {
			return c.json({ error: 'invalid telemetry event' }, 400);
		}
		const props = event.props == null ? null : JSON.stringify(event.props);
		if (props && props.length > 20_000) { return c.json({ error: 'telemetry properties are too large' }, 413); }
		rows.push({ ts: event.ts, kind: event.kind, props });
	}
	const insert = db.prepare(`INSERT INTO telemetry_events (client_id, user_id, ts, kind, props) VALUES (?, ?, ?, ?, ?)`);
	db.transaction(() => {
		for (const row of rows) insert.run(body.clientId, userId, row.ts, row.kind, row.props);
	})();
	return c.json({ ok: true, count: body.events.length });
});

telemetry.get('/stats', (c) => {
	const userId = c.get('userId') as string;
	const last24h = Date.now() - 24 * 60 * 60 * 1000;
	const rows = db.prepare(`SELECT kind, COUNT(*) AS count FROM telemetry_events WHERE user_id = ? AND ts > ? GROUP BY kind ORDER BY count DESC`).all(userId, last24h);
	return c.json(rows);
});
