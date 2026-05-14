import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { auth } from './auth.js';
import { billing } from './billing.js';
import { proxy } from './proxy.js';
import { sync } from './sync.js';
import { jobs } from './jobs.js';
import { telemetry } from './telemetry.js';
import { customFeatures } from './customFeatures.js';

const app = new Hono();

app.get('/', (c) => c.text('ai-code-server running'));
app.get('/healthz', (c) => c.json({ ok: true }));

app.route('/auth', auth);
app.route('/billing', billing);
app.route('/v1', proxy);
app.route('/sync', sync);
app.route('/jobs', jobs);
app.route('/telemetry', telemetry);
app.route('/custom', customFeatures);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`ai-code-server listening on http://localhost:${info.port}`);
});
