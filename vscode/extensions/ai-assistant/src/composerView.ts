import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { call } from './anthropic';
import { loadRulesAndMemory } from './rules';
import { CodebaseIndex } from './codebaseIndex';
import { checkpoints } from './checkpoints';

const SYSTEM = `You are a multi-file code-modification engine. Output a JSON array of file ops:
[
  {"path":"src/foo.ts","action":"create","content":"<full file>"},
  {"path":"src/bar.ts","action":"delete"},
  {"path":"src/baz.ts","action":"hunks","hunks":[
    {"old":"<exact existing text — must be unique in file>","new":"<replacement>"}
  ]}
]
Prefer "hunks" over rewriting whole files. Each hunk's "old" must match exactly and uniquely. Output ONLY the JSON array.`;

interface Hunk { old: string; new: string; }
interface FileChange {
	path: string;
	action: 'create' | 'overwrite' | 'delete' | 'hunks';
	content?: string;
	hunks?: Hunk[];
}

interface ChangeStatus { status: 'pending' | 'applied' | 'rejected' | 'error'; error?: string; }

export class ComposerViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'aiAssistant.composerView';
	private view?: vscode.WebviewView;
	private pendingChanges: FileChange[] = [];
	private statuses: ChangeStatus[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly index: CodebaseIndex) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage(async (msg) => {
			if (msg.type === 'generate') { await this.generate(msg.text); }
			else if (msg.type === 'applyAll') { await this.applyAll(); }
			else if (msg.type === 'rejectAll') { this.pendingChanges = []; this.statuses = []; this.post({ type: 'reset' }); }
			else if (msg.type === 'preview') { await this.preview(msg.index); }
			else if (msg.type === 'applyOne') { await this.applyOne(msg.index); }
			else if (msg.type === 'rejectOne') { this.rejectOne(msg.index); }
		});
	}

	reveal(): void { this.view?.show?.(true); }

	private async generate(task: string): Promise<void> {
		this.post({ type: 'thinking' });
		try {
			await this.index.ensureBuilt();
			const ctx = await this.index.formatContext(task, 6);
			const rules = await loadRulesAndMemory();
			// Fold system prompt into user message — the Claude Code CLI sometimes
			// overrides --system-prompt with its built-in agent prompt, which causes
			// the model to explain instead of outputting JSON.
			const sysAndRules = [SYSTEM, rules].filter(Boolean).join('\n\n');
			const userPrompt = `${sysAndRules}\n\n# Task\n${task}${ctx ? `\n\n# Likely-relevant code\n${ctx}` : ''}\n\nReturn ONLY the JSON array now, with no prose before or after.`;
			const r = await call({
				system: 'You output ONLY a JSON array of file ops. No prose, no explanations, no markdown fences.',
				messages: [{ role: 'user', content: userPrompt }],
				maxTokens: 8192,
				task: 'agent',
			});
			const changes = parseChanges(r.text);
			if (!changes.length) {
				this.post({ type: 'rawOutput', text: r.text });
				return;
			}
			this.pendingChanges = changes;
			this.statuses = changes.map(() => ({ status: 'pending' }));
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const previews = await Promise.all(changes.map(c => buildStats(root, c)));
			this.post({ type: 'plan', changes: previews });
		} catch (e: any) {
			this.post({ type: 'error', text: String(e?.message ?? e) });
		}
	}

	private async preview(index: number): Promise<void> {
		const c = this.pendingChanges[index];
		if (!c) { return; }
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { return; }
		const abs = path.join(root, c.path);

		let before = '';
		try { before = await fs.readFile(abs, 'utf8'); } catch { /* new file */ }
		const after = computeAfter(before, c);

		const tmpBefore = vscode.Uri.parse(`untitled:${abs}.before`);
		const tmpAfter = vscode.Uri.parse(`untitled:${abs}.proposed`);
		const e = new vscode.WorkspaceEdit();
		e.insert(tmpBefore, new vscode.Position(0, 0), before);
		e.insert(tmpAfter, new vscode.Position(0, 0), after);
		await vscode.workspace.applyEdit(e);
		await vscode.commands.executeCommand('vscode.diff', tmpBefore, tmpAfter, `${c.path} (proposed)`);
	}

	private async applyOne(index: number): Promise<void> {
		const c = this.pendingChanges[index];
		if (!c) { return; }
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { return; }
		await checkpoints.snapshot(`composer apply ${c.path}`, [c.path]);
		try {
			await applyChange(root, c);
			this.statuses[index] = { status: 'applied' };
		} catch (e: any) {
			this.statuses[index] = { status: 'error', error: String(e?.message ?? e) };
		}
		this.post({ type: 'status', index, status: this.statuses[index] });
	}

	private rejectOne(index: number): void {
		this.statuses[index] = { status: 'rejected' };
		this.post({ type: 'status', index, status: this.statuses[index] });
	}

	private async applyAll(): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { return; }
		await checkpoints.snapshot('composer apply', this.pendingChanges.map(c => c.path));
		for (let i = 0; i < this.pendingChanges.length; i++) {
			if (this.statuses[i]?.status !== 'pending') { continue; }
			try {
				await applyChange(root, this.pendingChanges[i]);
				this.statuses[i] = { status: 'applied' };
			} catch (e: any) {
				this.statuses[i] = { status: 'error', error: String(e?.message ?? e) };
			}
			this.post({ type: 'status', index: i, status: this.statuses[i] });
		}
		this.post({ type: 'allApplied' });
	}

	private post(msg: unknown): void { this.view?.webview.postMessage(msg); }

	private getHtml(): string {
		const nonce = String(Date.now());
		return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
:root {
	--border: var(--vscode-panel-border, var(--vscode-editorWidget-border));
	--muted: var(--vscode-descriptionForeground);
	--accent: var(--vscode-textLink-foreground);
	--hover: var(--vscode-list-hoverBackground);
	--add: var(--vscode-gitDecoration-addedResourceForeground, #4caf50);
	--del: var(--vscode-gitDecoration-deletedResourceForeground, #e53935);
	--mod: var(--vscode-gitDecoration-modifiedResourceForeground, #e69f00);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
	font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
	color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background));
	display: flex; flex-direction: column; height: 100vh;
}
.header {
	display: flex; align-items: center; justify-content: space-between;
	padding: 6px 10px; border-bottom: 1px solid var(--border); height: 30px;
}
.header-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .6px; opacity: .85; }
.header-status { font-size: 11px; opacity: .65; }

#log { flex: 1; overflow-y: auto; padding: 12px; }
#log::-webkit-scrollbar { width: 8px; }
#log::-webkit-scrollbar-thumb { background: rgba(127,127,127,.25); border-radius: 4px; }

.empty {
	display: flex; flex-direction: column; align-items: center; justify-content: center;
	height: 100%; opacity: .65; text-align: center; padding: 12px;
}
.empty .logo { font-size: 22px; margin-bottom: 6px; opacity: .5; }
.empty h3 { margin: 0 0 4px; font-weight: 500; font-size: 13px; }
.empty p { margin: 0; font-size: 11px; opacity: .8; }

.thinking { display: flex; align-items: center; gap: 8px; padding: 12px; opacity: .75; font-size: 12px; }
.spinner {
	width: 12px; height: 12px; border: 2px solid var(--border);
	border-top-color: var(--accent); border-radius: 50%;
	animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.summary {
	display: flex; align-items: center; gap: 8px;
	padding: 6px 10px; margin-bottom: 8px; font-size: 11px;
	background: var(--hover); border-radius: 4px;
}
.summary b { font-weight: 600; }
.summary .stat-add { color: var(--add); }
.summary .stat-del { color: var(--del); }

.change {
	border: 1px solid var(--border); border-radius: 6px;
	margin-bottom: 8px; overflow: hidden;
	transition: opacity .15s;
}
.change.applied { opacity: .55; }
.change.rejected { opacity: .35; }
.change.error { border-color: var(--del); }

.change-head {
	display: flex; align-items: center; gap: 8px;
	padding: 8px 10px; background: rgba(127,127,127,.05);
	border-bottom: 1px solid var(--border);
}
.action-badge {
	font-size: 9px; font-weight: 700; text-transform: uppercase;
	padding: 2px 6px; border-radius: 3px; letter-spacing: .5px;
	flex-shrink: 0;
}
.action-create { background: rgba(76,175,80,.18); color: var(--add); }
.action-overwrite { background: rgba(230,159,0,.18); color: var(--mod); }
.action-hunks { background: rgba(230,159,0,.18); color: var(--mod); }
.action-delete { background: rgba(229,57,53,.18); color: var(--del); }

.path {
	flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
	white-space: nowrap; font-family: var(--vscode-editor-font-family);
	font-size: 12px;
}
.stats { display: flex; gap: 6px; font-size: 11px; flex-shrink: 0; }
.stats .add { color: var(--add); }
.stats .del { color: var(--del); }

.change-actions {
	display: flex; gap: 4px; padding: 6px 8px;
	border-top: 1px solid var(--border);
	background: rgba(127,127,127,.03);
}
.change-actions button {
	background: transparent; border: 1px solid var(--border); color: inherit;
	padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 11px;
}
.change-actions button:hover { background: var(--hover); }
.change-actions button.primary {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground); border-color: transparent;
}
.change-actions button.primary:hover { background: var(--vscode-button-hoverBackground); }
.change-actions button:disabled { opacity: .4; cursor: not-allowed; }

.status-pill {
	font-size: 10px; padding: 2px 6px; border-radius: 3px; margin-left: auto;
	font-weight: 600; text-transform: uppercase; letter-spacing: .4px;
}
.status-applied { background: rgba(76,175,80,.18); color: var(--add); }
.status-rejected { background: rgba(127,127,127,.18); color: var(--muted); }
.status-error { background: rgba(229,57,53,.18); color: var(--del); }
.error-msg { padding: 6px 10px; font-size: 11px; color: var(--del); border-top: 1px solid var(--border); }

.toolbar {
	display: flex; gap: 6px; padding: 8px 10px;
	border-top: 1px solid var(--border);
}
.toolbar button {
	flex: 1; background: transparent; border: 1px solid var(--border); color: inherit;
	padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
}
.toolbar button:hover { background: var(--hover); }
.toolbar button.primary {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground); border-color: transparent;
}
.toolbar button.primary:hover { background: var(--vscode-button-hoverBackground); }
.toolbar button:disabled { opacity: .4; cursor: not-allowed; }

.input-area { padding: 8px 10px 10px; border-top: 1px solid var(--border); }
.input-wrap {
	display: flex; align-items: flex-end; gap: 6px;
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--border));
	border-radius: 6px; padding: 6px 8px;
}
.input-wrap:focus-within { border-color: var(--vscode-focusBorder, var(--accent)); }
#input {
	flex: 1; background: transparent; color: var(--vscode-input-foreground);
	border: none; outline: none; resize: none;
	font-family: inherit; font-size: 13px; line-height: 1.4;
	max-height: 160px; min-height: 20px; padding: 2px 0;
}
.send-btn {
	background: var(--vscode-button-background); color: var(--vscode-button-foreground);
	border: none; border-radius: 4px; width: 26px; height: 24px; cursor: pointer;
	display: inline-flex; align-items: center; justify-content: center;
	font-size: 13px; flex-shrink: 0;
}
.send-btn:hover { background: var(--vscode-button-hoverBackground); }

.err {
	background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.1));
	color: var(--vscode-inputValidation-errorForeground, inherit);
	border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255,0,0,.4));
	padding: 6px 10px; border-radius: 4px; font-size: 12px; margin-bottom: 8px;
}
</style></head><body>
<div class="header">
	<div class="header-title">Composer</div>
	<div class="header-status" id="hstatus"></div>
</div>
<div id="log"></div>
<div id="toolbar" class="toolbar" style="display:none">
	<button class="primary" id="applyAll">Apply All</button>
	<button id="rejectAll">Reject All</button>
</div>
<div class="input-area">
	<div class="input-wrap">
		<textarea id="input" rows="2" placeholder="Describe a multi-file change... (Enter to generate)"></textarea>
		<button class="send-btn" id="go" title="Generate">↑</button>
	</div>
</div>

<script nonce="${nonce}">
(function(){
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const toolbar = document.getElementById('toolbar');
const hstatus = document.getElementById('hstatus');
let plan = [];

renderEmpty();

function renderEmpty(){
	log.innerHTML = '<div class="empty">'
		+ '<div class="logo">⎘</div>'
		+ '<h3>Multi-file Composer</h3>'
		+ '<p>Describe a change spanning multiple files. You\\'ll review each diff before it\\'s applied.</p>'
		+ '</div>';
	toolbar.style.display = 'none';
	hstatus.textContent = '';
}

function escapeHtml(s){
	return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function actionClass(a){ return 'action-' + a; }

function renderPlan(changes){
	plan = changes;
	log.innerHTML = '';
	if (!changes.length){
		log.innerHTML = '<div class="empty"><h3>No changes proposed</h3><p>The model returned an empty plan.</p></div>';
		toolbar.style.display = 'none';
		return;
	}
	let totalAdd = 0, totalDel = 0;
	for (const c of changes){ totalAdd += c.add || 0; totalDel += c.del || 0; }
	const sum = document.createElement('div');
	sum.className = 'summary';
	sum.innerHTML = '<b>' + changes.length + '</b> file' + (changes.length !== 1 ? 's' : '')
		+ ' · <span class="stat-add">+' + totalAdd + '</span> <span class="stat-del">-' + totalDel + '</span>';
	log.appendChild(sum);

	changes.forEach(function(c, i){
		const el = document.createElement('div');
		el.className = 'change';
		el.setAttribute('data-i', i);
		el.innerHTML =
			  '<div class="change-head">'
			+   '<span class="action-badge ' + actionClass(c.action) + '">' + escapeHtml(c.action) + '</span>'
			+   '<span class="path" title="' + escapeHtml(c.path) + '">' + escapeHtml(c.path) + '</span>'
			+   '<span class="stats"><span class="add">+' + (c.add || 0) + '</span><span class="del">-' + (c.del || 0) + '</span></span>'
			+ '</div>'
			+ '<div class="change-actions">'
			+   '<button data-act="diff">View Diff</button>'
			+   '<button data-act="apply" class="primary">Apply</button>'
			+   '<button data-act="reject">Reject</button>'
			+ '</div>';
		log.appendChild(el);
		bindRow(el, i);
	});
	toolbar.style.display = 'flex';
	hstatus.textContent = changes.length + ' pending';
}

function bindRow(el, i){
	el.querySelectorAll('.change-actions button').forEach(function(b){
		b.onclick = function(){
			const act = b.getAttribute('data-act');
			if (act === 'diff') vscode.postMessage({ type: 'preview', index: i });
			else if (act === 'apply') vscode.postMessage({ type: 'applyOne', index: i });
			else if (act === 'reject') vscode.postMessage({ type: 'rejectOne', index: i });
		};
	});
}

function setRowStatus(i, status){
	const el = log.querySelector('.change[data-i="' + i + '"]');
	if (!el) return;
	el.classList.remove('applied','rejected','error');
	if (status.status !== 'pending') el.classList.add(status.status);
	const head = el.querySelector('.change-head');
	const old = head.querySelector('.status-pill'); if (old) old.remove();
	if (status.status !== 'pending'){
		const pill = document.createElement('span');
		pill.className = 'status-pill status-' + status.status;
		pill.textContent = status.status;
		head.appendChild(pill);
	}
	const old2 = el.querySelector('.error-msg'); if (old2) old2.remove();
	if (status.status === 'error' && status.error){
		const er = document.createElement('div');
		er.className = 'error-msg';
		er.textContent = status.error;
		el.appendChild(er);
	}
	el.querySelectorAll('.change-actions button').forEach(function(b){
		const act = b.getAttribute('data-act');
		if (act === 'apply' && status.status !== 'pending') b.disabled = true;
		if (act === 'reject' && status.status !== 'pending') b.disabled = true;
	});
	let pending = 0;
	plan.forEach(function(_, j){
		const e = log.querySelector('.change[data-i="' + j + '"]');
		if (e && !e.classList.contains('applied') && !e.classList.contains('rejected') && !e.classList.contains('error')) pending++;
	});
	hstatus.textContent = pending + ' pending';
}

document.getElementById('go').onclick = function(){
	const t = input.value.trim(); if (!t) return;
	log.innerHTML = '<div class="thinking"><div class="spinner"></div>Planning multi-file change…</div>';
	toolbar.style.display = 'none';
	hstatus.textContent = 'thinking';
	vscode.postMessage({ type: 'generate', text: t });
};
input.addEventListener('keydown', function(e){
	if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('go').click(); }
});
document.getElementById('applyAll').onclick = function(){ vscode.postMessage({ type: 'applyAll' }); };
document.getElementById('rejectAll').onclick = function(){ vscode.postMessage({ type: 'rejectAll' }); };

window.addEventListener('message', function(e){
	const m = e.data;
	if (m.type === 'thinking'){
		log.innerHTML = '<div class="thinking"><div class="spinner"></div>Planning multi-file change…</div>';
		toolbar.style.display = 'none';
	}
	else if (m.type === 'plan') renderPlan(m.changes);
	else if (m.type === 'status') setRowStatus(m.index, m.status);
	else if (m.type === 'allApplied') hstatus.textContent = 'done';
	else if (m.type === 'reset'){ renderEmpty(); input.value = ''; input.focus(); }
	else if (m.type === 'rawOutput'){
		log.innerHTML = '';
		const wrap = document.createElement('div');
		wrap.style.cssText = 'padding:10px;font-size:12px';
		wrap.innerHTML = '<div style="color:var(--del);margin-bottom:8px;font-weight:600">Empty plan — model did not return parseable JSON.</div>'
			+ '<div style="opacity:.7;margin-bottom:6px;font-size:11px">Raw output (so you can see why):</div>'
			+ '<pre style="background:var(--code-bg);padding:8px;border-radius:4px;max-height:400px;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:11px;white-space:pre-wrap;word-break:break-word">' + escapeHtml(m.text || '(empty)') + '</pre>';
		log.appendChild(wrap);
		toolbar.style.display = 'none';
		hstatus.textContent = 'no changes';
	}
	else if (m.type === 'error'){
		log.innerHTML = '';
		const el = document.createElement('div'); el.className = 'err'; el.textContent = m.text;
		log.appendChild(el);
	}
});
})();
</script></body></html>`;
	}
}

function parseChanges(s: string): FileChange[] {
	const m = s.match(/\[[\s\S]*\]/);
	if (!m) { return []; }
	try {
		const raw = JSON.parse(m[0]);
		if (!Array.isArray(raw)) { return []; }
		return raw.filter((x: any) => x && typeof x.path === 'string' && typeof x.action === 'string');
	} catch { return []; }
}

function computeAfter(before: string, c: FileChange): string {
	if (c.action === 'delete') { return ''; }
	if (c.action === 'hunks') {
		let after = before;
		for (const h of c.hunks ?? []) {
			const i = after.indexOf(h.old);
			if (i === -1) { continue; }
			after = after.slice(0, i) + h.new + after.slice(i + h.old.length);
		}
		return after;
	}
	return c.content ?? '';
}

async function buildStats(root: string | undefined, c: FileChange): Promise<{ path: string; action: string; add: number; del: number }> {
	let add = 0, del = 0;
	try {
		if (root) {
			const abs = path.join(root, c.path);
			const before = await fs.readFile(abs, 'utf8').catch(() => '');
			const after = computeAfter(before, c);
			const beforeLines = before ? before.split('\n').length : 0;
			const afterLines = after ? after.split('\n').length : 0;
			if (c.action === 'create') { add = afterLines; del = 0; }
			else if (c.action === 'delete') { add = 0; del = beforeLines; }
			else if (c.action === 'overwrite') { add = afterLines; del = beforeLines; }
			else if (c.action === 'hunks') {
				for (const h of c.hunks ?? []) {
					add += (h.new.match(/\n/g)?.length ?? 0) + 1;
					del += (h.old.match(/\n/g)?.length ?? 0) + 1;
				}
			}
		}
	} catch { /* ignore */ }
	return { path: c.path, action: c.action, add, del };
}

async function applyChange(root: string, c: FileChange): Promise<void> {
	const abs = path.join(root, c.path);
	if (c.action === 'delete') {
		await fs.unlink(abs).catch(() => undefined);
		return;
	}
	if (c.action === 'hunks') {
		let text = await fs.readFile(abs, 'utf8');
		for (const h of c.hunks ?? []) {
			const i = text.indexOf(h.old);
			if (i === -1) { throw new Error(`hunk not found in ${c.path}`); }
			if (text.indexOf(h.old, i + 1) !== -1) { throw new Error(`hunk not unique in ${c.path}`); }
			text = text.slice(0, i) + h.new + text.slice(i + h.old.length);
		}
		await fs.writeFile(abs, text, 'utf8');
		return;
	}
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, c.content ?? '', 'utf8');
}
