import { db } from './db.js';

const PLAN_LIMITS: Record<string, { dailyTokens: number }> = {
	free: { dailyTokens: 50_000 },
	pro: { dailyTokens: 5_000_000 },
};

export function checkQuota(userId: string, plan: string): { ok: boolean; remaining: number } {
	const limit = (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free).dailyTokens;
	const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
	const row = db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM usage WHERE user_id = ? AND ts > ?`)
		.get(userId, dayStart.getTime()) as { total: number };
	return { ok: row.total < limit, remaining: Math.max(0, limit - row.total) };
}

export function recordUsage(userId: string, model: string, inTok: number, outTok: number, costMicros: number): void {
	db.prepare(`INSERT INTO usage (user_id, ts, model, input_tokens, output_tokens, cost_micros) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(userId, Date.now(), model, inTok, outTok, costMicros);
}
