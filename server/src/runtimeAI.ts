import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { authMiddleware, type AppEnv } from './auth.js';
import { db } from './db.js';

export const runtimeAI = new Hono<AppEnv>();

runtimeAI.post('/cursor-advice', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null) as { prompt?: string } | null;
  const prompt = String(body?.prompt || '').trim();
  if (!prompt) return c.json({ error: 'prompt is required' }, 400);
  const apiKey = process.env.OPENROUTER_API_KEY, baseUrl = process.env.OPENROUTER_BASE_URL, model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !baseUrl || !model) return c.json({ error: 'OpenRouter is not configured' }, 503);
  const providerResponse = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: 'Provide concise AI coding operations advice with risks and auditable next actions.' }, { role: 'user', content: prompt }], temperature: 0.2 }),
  });
  if (!providerResponse.ok) return c.json({ error: 'OpenRouter returned ' + providerResponse.status }, 502);
  const payload = await providerResponse.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) return c.json({ error: 'OpenRouter returned empty content' }, 502);
  const persistedId = randomUUID(), userId = c.get('userId') as string;
  db.prepare("INSERT INTO runtime_ai_results(id,user_id,prompt,content,provider,model,created_at) VALUES(?,?,?,?, 'openrouter',?,?)")
    .run(persistedId, userId, prompt, content, model, Date.now());
  return c.json({ content, provider: 'openrouter', model, persistedId });
});
