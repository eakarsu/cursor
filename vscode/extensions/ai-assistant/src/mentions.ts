import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as cp from 'child_process';
import { readNotepad } from './notepads';

export interface ResolvedMention {
	label: string;
	content: string;
}

const MENTION_RE = /@(file|symbol|docs|git|web|selection|notepad):([^\s]+)/g;
const CODEBASE_RE = /@codebase\b/g;
const PAST_CHATS_RE = /@past_chats\b/g;

let codebaseQuery: ((q: string) => Promise<string>) | undefined;
export function setCodebaseResolver(fn: (q: string) => Promise<string>): void { codebaseQuery = fn; }
let pastChatsQuery: ((q: string) => Promise<string>) | undefined;
export function setPastChatsResolver(fn: (q: string) => Promise<string>): void { pastChatsQuery = fn; }

export async function resolveMentions(text: string): Promise<{ cleaned: string; resolved: ResolvedMention[] }> {
	const resolved: ResolvedMention[] = [];
	const matches = [...text.matchAll(MENTION_RE)];
	for (const m of matches) {
		const [, kind, value] = m;
		const r = await resolveOne(kind, value);
		if (r) { resolved.push(r); }
	}
	if (CODEBASE_RE.test(text) && codebaseQuery) {
		const stripped = text.replace(CODEBASE_RE, '').replace(PAST_CHATS_RE, '').replace(MENTION_RE, '').trim();
		const content = await codebaseQuery(stripped || text);
		if (content) { resolved.push({ label: '@codebase', content }); }
	}
	if (PAST_CHATS_RE.test(text) && pastChatsQuery) {
		const stripped = text.replace(PAST_CHATS_RE, '').replace(CODEBASE_RE, '').replace(MENTION_RE, '').trim();
		const content = await pastChatsQuery(stripped || text);
		if (content) { resolved.push({ label: '@past_chats', content }); }
	}
	const cleaned = text.replace(MENTION_RE, (full) => full);
	return { cleaned, resolved };
}

async function resolveOne(kind: string, value: string): Promise<ResolvedMention | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	switch (kind) {
		case 'file': {
			if (!root) { return; }
			try {
				const text = await fs.readFile(path.join(root, value), 'utf8');
				return { label: `@file:${value}`, content: text.slice(0, 30000) };
			} catch { return; }
		}
		case 'symbol': {
			const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
				'vscode.executeWorkspaceSymbolProvider', value
			);
			if (!symbols?.length) { return; }
			const top = symbols.slice(0, 5);
			const parts: string[] = [];
			for (const s of top) {
				try {
					const doc = await vscode.workspace.openTextDocument(s.location.uri);
					parts.push(`// ${vscode.workspace.asRelativePath(s.location.uri)}\n${doc.getText(s.location.range)}`);
				} catch { /* skip */ }
			}
			return { label: `@symbol:${value}`, content: parts.join('\n\n') };
		}
		case 'git': {
			if (!root) { return; }
			return await new Promise(resolve => {
				cp.exec(`git ${value}`, { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 }, (_err, stdout, stderr) => {
					resolve({ label: `@git:${value}`, content: (stdout + stderr).slice(0, 8000) });
				});
			});
		}
		case 'docs':
		case 'web': {
			try {
				const ctrl = new AbortController();
				const timer = setTimeout(() => ctrl.abort(), 10000);
				const res = await fetch(value, {
					signal: ctrl.signal,
					headers: { 'user-agent': 'Mozilla/5.0 AI-Assistant/1.0', 'accept': 'text/html,text/plain,application/json' },
					redirect: 'follow',
				});
				clearTimeout(timer);
				if (!res.ok) { return { label: `@${kind}:${value}`, content: `(fetch failed: ${res.status})` }; }
				const ctype = res.headers.get('content-type') ?? '';
				const raw = await res.text();
				const body = ctype.includes('html') ? extractMain(raw) : raw;
				return { label: `@${kind}:${value}`, content: body.slice(0, 20000) };
			} catch (e: any) { return { label: `@${kind}:${value}`, content: `(fetch error: ${e?.message ?? e})` }; }
		}
		case 'notepad': {
			const text = await readNotepad(value);
			if (!text) { return; }
			return { label: `@notepad:${value}`, content: text };
		}
		case 'selection': {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return; }
			const sel = editor.document.getText(editor.selection);
			if (!sel.trim()) { return; }
			return { label: `@selection`, content: sel };
		}
	}
	return undefined;
}

function stripHtml(html: string): string {
	return html.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// Try to extract <main>, <article>, or the largest content region; fall back to body.
function extractMain(html: string): string {
	const tryTag = (tag: string): string | undefined => {
		const m = html.match(new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)</${tag}>`, 'i'));
		return m?.[1];
	};
	const candidate = tryTag('main') ?? tryTag('article') ?? tryTag('body') ?? html;
	return stripHtml(candidate);
}

export function formatMentions(resolved: ResolvedMention[]): string {
	if (!resolved.length) { return ''; }
	return resolved.map(r => `### ${r.label}\n\`\`\`\n${r.content}\n\`\`\``).join('\n\n');
}
