import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

interface PastTurn { ts: number; user: string; assistant: string; }

let storeDir: string | undefined;
let cache: PastTurn[] | undefined;

export function init(context: vscode.ExtensionContext): void {
	storeDir = path.join(context.globalStorageUri.fsPath, 'pastChats');
	void fs.mkdir(storeDir, { recursive: true }).catch(() => undefined);
}

export async function recordTurn(user: string, assistant: string): Promise<void> {
	if (!storeDir) { return; }
	const turn: PastTurn = { ts: Date.now(), user: user.slice(0, 4000), assistant: assistant.slice(0, 8000) };
	const file = path.join(storeDir, 'turns.jsonl');
	try {
		await fs.appendFile(file, JSON.stringify(turn) + '\n', 'utf8');
		if (cache) { cache.push(turn); if (cache.length > 2000) { cache = cache.slice(-2000); } }
	} catch { /* ignore */ }
}

async function loadAll(): Promise<PastTurn[]> {
	if (cache) { return cache; }
	if (!storeDir) { return []; }
	const file = path.join(storeDir, 'turns.jsonl');
	try {
		const text = await fs.readFile(file, 'utf8');
		const out: PastTurn[] = [];
		for (const line of text.split('\n')) {
			if (!line.trim()) { continue; }
			try { out.push(JSON.parse(line)); } catch { /* skip */ }
		}
		cache = out.slice(-2000);
		return cache;
	} catch { cache = []; return cache; }
}

export async function searchPastChats(query: string, k = 5): Promise<string> {
	const turns = await loadAll();
	if (!turns.length) { return ''; }
	const terms = query.toLowerCase().split(/\W+/).filter(t => t.length > 2);
	const scored = turns.map(t => {
		const hay = (t.user + ' ' + t.assistant).toLowerCase();
		let score = 0;
		for (const term of terms) { if (hay.includes(term)) { score += 1; } }
		return { t, score };
	}).filter(s => s.score > 0)
		.sort((a, b) => b.score - a.score || b.t.ts - a.t.ts)
		.slice(0, k);
	if (!scored.length) { return ''; }
	return scored.map(s => {
		const date = new Date(s.t.ts).toISOString().slice(0, 16).replace('T', ' ');
		return `[${date}]\nUser: ${s.t.user}\nAssistant: ${s.t.assistant.slice(0, 800)}`;
	}).join('\n\n---\n\n');
}
