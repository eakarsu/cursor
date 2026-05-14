import { Hono } from 'hono';
import { db } from './db.js';

export const telemetry = new Hono();

telemetry.post('/', async (c) => {
	const body = await c.req.json() as { clientId: string; events: Array<{ ts: number; kind: string; props?: any }> };
	const stmt = db.prepare(`INSERT INTO telemetry_events (client_id, user_id, ts, kind, props) VALUES (?, ?, ?, ?, ?)`);
	const userHeader = c.req.header('x-user-id');
	for (const ev of body.events.slice(0, 500)) {
		stmt.run(body.clientId, userHeader ?? null, ev.ts, ev.kind, ev.props ? JSON.stringify(ev.props) : null);
	}
	return c.json({ ok: true });
});

// Tiny analytics readout
telemetry.get('/stats', (c) => {
	const last24h = Date.now() - 24 * 60 * 60 * 1000;
	const rows = db.prepare(`SELECT kind, COUNT(*) AS count FROM telemetry_events WHERE ts > ? GROUP BY kind ORDER BY count DESC`).all(last24h);
	return c.json(rows);
});
