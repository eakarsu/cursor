import { Hono } from 'hono';
import { authMiddleware } from './auth.js';
import { checkQuota, recordUsage } from './quota.js';
import { getUser } from './db.js';

export const proxy = new Hono();

proxy.use('/messages', authMiddleware);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? '';

// Simple price table in $/M tokens (input, output) — keep up to date or load from a config file.
const PRICES: Record<string, { input: number; output: number }> = {
	'claude-opus-4-7': { input: 15, output: 75 },
	'claude-sonnet-4-6': { input: 3, output: 15 },
	'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
};

proxy.post('/messages', async (c) => {
	const userId = c.get('userId') as string;
	const user = getUser(userId);
	if (!user) { return c.json({ error: 'user not found' }, 404); }
	const q = checkQuota(user.id, user.plan);
	if (!q.ok) { return c.json({ error: 'quota exceeded', remaining: 0 }, 429); }

	const body = await c.req.json();
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': ANTHROPIC_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		return c.json({ error: 'upstream', detail: await res.text() }, res.status as any);
	}
	const json: any = await res.json();
	const usage = json.usage ?? {};
	const price = PRICES[body.model] ?? { input: 5, output: 25 };
	const cost = Math.round(((usage.input_tokens ?? 0) * price.input + (usage.output_tokens ?? 0) * price.output));
	recordUsage(user.id, body.model, usage.input_tokens ?? 0, usage.output_tokens ?? 0, cost);
	return c.json(json);
});
