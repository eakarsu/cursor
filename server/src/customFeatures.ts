// Custom feature endpoints (batch_09 audit suggestions)
// Hono router covering: tenant model routing, spend caps, prompt template versioning,
// privacy redaction, edge cache for deterministic prompts.
import { Hono } from 'hono';
import { authMiddleware } from './auth.js';

export const customFeatures = new Hono();

customFeatures.use('*', authMiddleware);

// In-memory stores (v0). A real deploy should persist via the existing db.ts.
const tenantRouting = new Map<string, { default_model: string; rules: any[] }>();
const spendCaps = new Map<string, { daily_usd: number; alert_pct: number }>();
const promptTemplates = new Map<string, { versions: { v: number; body: string; createdAt: string }[] }>();
const promptCache = new Map<string, { response: any; createdAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

// 1. Tenant-scoped model routing
customFeatures.post('/routing', async (c) => {
	const userId = c.get('userId') as string;
	const body = await c.req.json().catch(() => ({} as any));
	const { default_model, rules } = body || {};
	if (!default_model) return c.json({ error: 'default_model required' }, 400);
	tenantRouting.set(userId, { default_model, rules: Array.isArray(rules) ? rules : [] });
	return c.json({ ok: true, tenant: userId, default_model, rules: rules || [] });
});

customFeatures.get('/routing', async (c) => {
	const userId = c.get('userId') as string;
	return c.json(tenantRouting.get(userId) || { default_model: null, rules: [] });
});

// 2. Spend caps with hard/soft alerts
customFeatures.post('/spend-cap', async (c) => {
	const userId = c.get('userId') as string;
	const body = await c.req.json().catch(() => ({} as any));
	const daily_usd = Number(body?.daily_usd);
	const alert_pct = Number(body?.alert_pct ?? 80);
	if (!Number.isFinite(daily_usd) || daily_usd <= 0) return c.json({ error: 'daily_usd required > 0' }, 400);
	spendCaps.set(userId, { daily_usd, alert_pct });
	return c.json({ ok: true, tenant: userId, daily_usd, alert_pct });
});

customFeatures.get('/spend-cap', async (c) => {
	const userId = c.get('userId') as string;
	return c.json(spendCaps.get(userId) || { daily_usd: null, alert_pct: null });
});

// 3. Prompt template versioning shared across team
customFeatures.post('/templates/:name', async (c) => {
	const userId = c.get('userId') as string;
	const name = c.req.param('name');
	const body = await c.req.json().catch(() => ({} as any));
	const { template_body } = body || {};
	if (!template_body) return c.json({ error: 'template_body required' }, 400);
	const key = `${userId}:${name}`;
	const existing = promptTemplates.get(key) || { versions: [] };
	const v = existing.versions.length + 1;
	existing.versions.push({ v, body: template_body, createdAt: new Date().toISOString() });
	promptTemplates.set(key, existing);
	return c.json({ name, version: v });
});

customFeatures.get('/templates/:name', async (c) => {
	const userId = c.get('userId') as string;
	const key = `${userId}:${c.req.param('name')}`;
	return c.json(promptTemplates.get(key) || { versions: [] });
});

// 4. Privacy mode — redact PII before forwarding to model
// TODO: configure credentials for PII_REDACTOR_API_KEY for premium classifier.
customFeatures.post('/privacy/redact', async (c) => {
	const body = await c.req.json().catch(() => ({} as any));
	const { text } = body || {};
	if (typeof text !== 'string') return c.json({ error: 'text required' }, 400);
	// Conservative regex-only v0: emails, US phones, simple SSN, credit-card-ish.
	let redacted = text;
	const spans: { start: number; end: number; class: string }[] = [];
	const patterns: { re: RegExp; cls: string; tag: string }[] = [
		{ re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, cls: 'EMAIL', tag: '[EMAIL]' },
		{ re: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, cls: 'SSN', tag: '[SSN]' },
		{ re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, cls: 'PHONE', tag: '[PHONE]' },
		{ re: /\b(?:\d[ -]*?){13,16}\b/g, cls: 'CARD', tag: '[CARD]' },
	];
	for (const { re, cls, tag } of patterns) {
		redacted = redacted.replace(re, (m, off) => {
			spans.push({ start: typeof off === 'number' ? off : 0, end: 0, class: cls });
			return tag;
		});
	}
	return c.json({
		redacted_text: redacted,
		spans,
		premium_classifier_configured: Boolean(process.env.PII_REDACTOR_API_KEY),
	});
});

// 5. Edge cache for deterministic prompts
customFeatures.post('/cache/get', async (c) => {
	const body = await c.req.json().catch(() => ({} as any));
	const { key } = body || {};
	if (!key) return c.json({ error: 'key required' }, 400);
	const hit = promptCache.get(key);
	if (!hit || Date.now() - hit.createdAt > CACHE_TTL_MS) {
		return c.json({ hit: false });
	}
	return c.json({ hit: true, response: hit.response, age_ms: Date.now() - hit.createdAt });
});

customFeatures.post('/cache/put', async (c) => {
	const body = await c.req.json().catch(() => ({} as any));
	const { key, response } = body || {};
	if (!key || response == null) return c.json({ error: 'key and response required' }, 400);
	promptCache.set(key, { response, createdAt: Date.now() });
	return c.json({ ok: true, key });
});
