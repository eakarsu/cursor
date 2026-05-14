import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

const RULES_FILE = '.aicode/rules.md';
const MEMORY_FILE = '.aicode/memory.md';

async function readWorkspaceFile(rel: string): Promise<string | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return undefined; }
	try {
		return await fs.readFile(path.join(root, rel), 'utf8');
	} catch {
		return undefined;
	}
}

export async function loadRulesAndMemory(activeFile?: string): Promise<string> {
	const [rules, memory, mdcRules] = await Promise.all([
		readWorkspaceFile(RULES_FILE),
		readWorkspaceFile(MEMORY_FILE),
		loadMdcRules(activeFile),
	]);
	const parts: string[] = [];
	if (rules?.trim()) { parts.push('# Project Rules\n' + rules.trim()); }
	if (mdcRules) { parts.push('# Scoped Rules\n' + mdcRules); }
	if (memory?.trim()) { parts.push('# Project Memory\n' + memory.trim()); }
	return parts.join('\n\n');
}

interface MdcRule { name: string; description?: string; globs?: string[]; alwaysApply?: boolean; body: string; relPath: string; }

async function loadMdcRules(activeFile?: string): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return ''; }
	const dir = path.join(root, '.cursor', 'rules');
	const rules = await collectMdc(dir, root);
	if (!rules.length) { return ''; }
	const rel = activeFile ? path.relative(root, activeFile).replace(/\\/g, '/') : '';
	const matches = rules.filter(r => r.alwaysApply || (rel && (r.globs ?? []).some(g => mdcMatch(g, rel))));
	if (!matches.length) { return ''; }
	return matches.map(r => `## ${r.name}${r.description ? ` — ${r.description}` : ''}\n${r.body.trim()}`).join('\n\n');
}

async function collectMdc(dir: string, root: string): Promise<MdcRule[]> {
	const out: MdcRule[] = [];
	let entries: any[] = [];
	try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) { out.push(...await collectMdc(full, root)); }
		else if (e.isFile() && e.name.endsWith('.mdc')) {
			try {
				const raw = await fs.readFile(full, 'utf8');
				const parsed = parseMdc(raw, path.relative(root, full));
				if (parsed) { out.push(parsed); }
			} catch { /* skip */ }
		}
	}
	return out;
}

function parseMdc(raw: string, relPath: string): MdcRule | undefined {
	const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	const fm: Record<string, any> = {};
	let body = raw;
	if (m) {
		body = m[2];
		for (const line of m[1].split('\n')) {
			const kv = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
			if (kv) {
				let v: any = kv[2].trim();
				if (v === 'true') { v = true; }
				else if (v === 'false') { v = false; }
				else if (v.startsWith('[') && v.endsWith(']')) {
					v = v.slice(1, -1).split(',').map((x: string) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
				} else { v = v.replace(/^["']|["']$/g, ''); }
				fm[kv[1]] = v;
			}
		}
	}
	const globs = Array.isArray(fm.globs) ? fm.globs : (typeof fm.globs === 'string' && fm.globs ? [fm.globs] : []);
	return {
		name: fm.name ?? path.basename(relPath, '.mdc'),
		description: fm.description,
		globs,
		alwaysApply: !!fm.alwaysApply,
		body,
		relPath,
	};
}

function mdcMatch(glob: string, rel: string): boolean {
	const re = glob
		.replace(/[.+^${}()|[\]]/g, '\\$&')
		.replace(/\*\*/g, '§§')
		.replace(/\*/g, '[^/]*')
		.replace(/§§/g, '.*')
		.replace(/\?/g, '[^/]');
	return new RegExp('^' + re + '$').test(rel);
}

async function ensureFile(rel: string, template: string): Promise<vscode.Uri | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showErrorMessage('Open a workspace folder first.');
		return undefined;
	}
	const dir = path.join(root, '.aicode');
	const file = path.join(root, rel);
	try {
		await fs.mkdir(dir, { recursive: true });
		try { await fs.access(file); }
		catch { await fs.writeFile(file, template, 'utf8'); }
	} catch (e: any) {
		vscode.window.showErrorMessage(`Failed to create ${rel}: ${e?.message ?? e}`);
		return undefined;
	}
	return vscode.Uri.file(file);
}

export async function editRules(): Promise<void> {
	const uri = await ensureFile(RULES_FILE, '# AI Rules\n\nGuidelines that apply to every AI request in this workspace.\n\n- Keep changes minimal.\n- Match existing code style.\n');
	if (uri) {
		await vscode.window.showTextDocument(uri);
	}
}

export async function editMemory(): Promise<void> {
	const uri = await ensureFile(MEMORY_FILE, '# Project Memory\n\nFacts about this project the AI should know.\n\n- \n');
	if (uri) {
		await vscode.window.showTextDocument(uri);
	}
}
