import * as vscode from 'vscode';
import { Agent, AgentEvent } from './agent';
import { CodebaseIndex } from './codebaseIndex';

export class AgentViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'aiAssistant.agentView';
	private view?: vscode.WebviewView;
	private currentAbort: AbortController | undefined;

	constructor(private readonly extensionUri: vscode.Uri, private readonly index: CodebaseIndex) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage(async (msg) => {
			if (msg.type === 'run') { await this.run(msg.text); }
			else if (msg.type === 'stop') { this.currentAbort?.abort(); }
			else if (msg.type === 'approve') { this.resolveApproval?.(true); this.resolveApproval = undefined; }
			else if (msg.type === 'reject') { this.resolveApproval?.(false); this.resolveApproval = undefined; }
		});
	}

	reveal(): void { this.view?.show?.(true); }

	private resolveApproval: ((ok: boolean) => void) | undefined;

	async runDirect(task: string): Promise<void> {
		this.reveal();
		this.post({ type: 'task', text: task });
		await this.run(task);
	}

	private async run(task: string): Promise<void> {
		this.currentAbort?.abort();
		const ctrl = new AbortController();
		this.currentAbort = ctrl;
		this.post({ type: 'running', on: true });
		const agent = new Agent(this.index);
		try {
			await agent.run(
				task,
				(e: AgentEvent) => this.post(e),
				async (req) => {
					this.post({ type: 'approval', tool: req.name, preview: req.preview });
					return new Promise<boolean>(resolve => { this.resolveApproval = resolve; });
				},
				ctrl.signal
			);
		} finally {
			this.post({ type: 'running', on: false });
		}
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
	--code-bg: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1));
	--hover: var(--vscode-list-hoverBackground);
	--ok: var(--vscode-charts-green, #4caf50);
	--warn: var(--vscode-charts-orange, #e69f00);
	--bad: var(--vscode-errorForeground, #e53935);
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
.header-status { font-size: 11px; opacity: .7; display: flex; align-items: center; gap: 6px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.dot.run { background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
.dot.ok { background: var(--ok); }
.dot.err { background: var(--bad); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

#log {
	flex: 1; overflow-y: auto; padding: 12px;
}
#log::-webkit-scrollbar { width: 8px; }
#log::-webkit-scrollbar-thumb { background: rgba(127,127,127,.25); border-radius: 4px; }

.empty {
	display: flex; flex-direction: column; align-items: stretch; justify-content: center;
	height: 100%; padding: 12px 4px; text-align: center; opacity: .9;
}
.empty .logo { font-size: 22px; margin-bottom: 6px; opacity: .5; }
.empty h3 { margin: 0 0 4px; font-weight: 500; font-size: 13px; }
.empty p { margin: 0 0 14px; font-size: 11px; opacity: .65; }
.examples { display: flex; flex-direction: column; gap: 6px; }
.example {
	padding: 8px 10px; border: 1px solid var(--border);
	border-radius: 6px; cursor: pointer; font-size: 12px;
	text-align: left; background: transparent; color: inherit;
}
.example:hover { background: var(--hover); border-color: var(--accent); }

/* Timeline */
.timeline { position: relative; padding-left: 20px; }
.timeline::before {
	content: ''; position: absolute; left: 9px; top: 6px; bottom: 6px;
	width: 1px; background: var(--border);
}
.row {
	position: relative; margin-bottom: 12px;
	animation: slideIn .18s ease;
}
@keyframes slideIn { from { opacity: 0; transform: translateX(-3px); } to { opacity: 1; transform: none; } }
.row::before {
	content: ''; position: absolute; left: -16px; top: 6px;
	width: 9px; height: 9px; border-radius: 50%;
	background: var(--vscode-sideBar-background, var(--vscode-editor-background));
	border: 2px solid var(--muted);
}
.row.task::before { border-color: var(--accent); background: var(--accent); }
.row.text::before { border-color: var(--accent); }
.row.tool::before { border-color: var(--warn); }
.row.result::before { border-color: var(--ok); }
.row.done::before { border-color: var(--ok); background: var(--ok); }
.row.error::before { border-color: var(--bad); background: var(--bad); }
.row.thinking::before { border-color: var(--muted); animation: pulse 1.4s ease-in-out infinite; }
.row.checkpoint::before { border-color: var(--muted); background: var(--muted); }
.row.approval::before { border-color: var(--warn); background: var(--warn); }

.row-label {
	font-size: 10px; font-weight: 600; text-transform: uppercase;
	letter-spacing: .5px; opacity: .55; margin-bottom: 2px;
	display: flex; align-items: center; gap: 6px;
}
.tool-icon {
	display: inline-block; width: 14px; text-align: center; opacity: .7;
}
.row-body {
	background: var(--code-bg); padding: 6px 9px; border-radius: 4px;
	font-size: 12px; line-height: 1.45; word-wrap: break-word;
}
.row.text .row-body { background: transparent; padding: 0; line-height: 1.5; }
.row.task .row-body { background: var(--code-bg); font-style: italic; }
.row.thinking .row-body { background: transparent; padding: 0; opacity: .55; font-style: italic; }
.row.checkpoint .row-body { background: transparent; padding: 0; font-size: 10px; opacity: .55; font-family: var(--vscode-editor-font-family); }
.row.error .row-body {
	background: rgba(229,57,53,.12); border: 1px solid rgba(229,57,53,.4);
	color: var(--bad);
}

.tool-name { font-family: var(--vscode-editor-font-family); font-weight: 600; color: var(--accent); }
.tool-args {
	font-family: var(--vscode-editor-font-family); font-size: 11px;
	margin-top: 4px; padding: 4px 6px; background: rgba(127,127,127,.08);
	border-radius: 3px; white-space: pre-wrap; word-break: break-all;
	max-height: 80px; overflow-y: auto;
}

.collapsible-head {
	display: flex; align-items: center; gap: 6px; cursor: pointer;
	user-select: none; padding: 1px 0;
}
.chev { display: inline-block; width: 10px; transition: transform .15s; opacity: .5; }
.collapsible.open .chev { transform: rotate(90deg); }
.collapsible-body {
	display: none; margin-top: 4px;
	font-family: var(--vscode-editor-font-family); font-size: 11px;
	background: rgba(127,127,127,.06); border-radius: 3px;
	padding: 6px 8px; max-height: 240px; overflow: auto;
	white-space: pre-wrap; word-break: break-word;
}
.collapsible.open .collapsible-body { display: block; }

.approval {
	border: 1px solid var(--warn); background: rgba(230,159,0,.1);
	padding: 8px 10px; border-radius: 4px;
}
.approval .a-title { font-weight: 600; margin-bottom: 4px; font-size: 12px; }
.approval .a-prev {
	font-family: var(--vscode-editor-font-family); font-size: 11px;
	background: rgba(127,127,127,.1); padding: 4px 6px; border-radius: 3px;
	margin: 4px 0 8px; max-height: 100px; overflow: auto;
	white-space: pre-wrap; word-break: break-all;
}
.approval-actions { display: flex; gap: 6px; }
.approval-actions button {
	flex: 1; border: 1px solid var(--border); background: transparent;
	color: inherit; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px;
}
.approval-actions button.primary {
	background: var(--vscode-button-background); color: var(--vscode-button-foreground);
	border-color: transparent;
}
.approval-actions button.primary:hover { background: var(--vscode-button-hoverBackground); }
.approval-actions button:hover { background: var(--hover); }

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
.send-btn.running { background: var(--bad); }
</style></head><body>
<div class="header">
	<div class="header-title">Agent</div>
	<div class="header-status"><span class="dot" id="dot"></span><span id="state">idle</span></div>
</div>
<div id="log"></div>
<div class="input-area">
	<div class="input-wrap">
		<textarea id="input" rows="2" placeholder="Describe a task — the agent will plan, read, edit, and run commands."></textarea>
		<button class="send-btn" id="run" title="Run">↑</button>
	</div>
</div>

<script nonce="${nonce}">
(function(){
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const runBtn = document.getElementById('run');
const dot = document.getElementById('dot');
const stateEl = document.getElementById('state');
let running = false;
let timeline = null;

renderEmpty();

function renderEmpty(){
	log.innerHTML = '<div class="empty">'
		+ '<div class="logo">⚙</div>'
		+ '<h3>Autonomous Agent</h3>'
		+ '<p>Describe a task. The agent reads, edits, and runs commands until it\\'s done.</p>'
		+ '<div class="examples">'
		+   '<button class="example" data-q="Add a /health endpoint that returns {ok:true}">Add a /health endpoint</button>'
		+   '<button class="example" data-q="Find and fix any TODO comments in src/">Resolve TODOs in src/</button>'
		+   '<button class="example" data-q="Write tests for the most recently modified file">Write tests for recent changes</button>'
		+ '</div></div>';
	log.querySelectorAll('.example').forEach(function(b){
		b.addEventListener('click', function(){
			input.value = b.getAttribute('data-q');
			input.focus();
		});
	});
	timeline = null;
}

function ensureTimeline(){
	if (timeline) return timeline;
	log.innerHTML = '';
	timeline = document.createElement('div');
	timeline.className = 'timeline';
	log.appendChild(timeline);
	return timeline;
}

function escapeHtml(s){
	return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toolIcon(name){
	if (!name) return '•';
	if (name.indexOf('read') >= 0) return '📄';
	if (name.indexOf('write') >= 0 || name.indexOf('edit') >= 0) return '✎';
	if (name.indexOf('search') >= 0 || name.indexOf('grep') >= 0 || name.indexOf('find') >= 0) return '🔍';
	if (name.indexOf('run') >= 0 || name.indexOf('shell') >= 0 || name.indexOf('exec') >= 0) return '▶';
	if (name.indexOf('list') >= 0) return '☰';
	if (name.indexOf('mcp') === 0) return '⊕';
	return '•';
}

function appendRow(cls, label, bodyHtml){
	const tl = ensureTimeline();
	const removeThinking = tl.querySelector('.row.thinking');
	if (removeThinking) removeThinking.remove();
	const row = document.createElement('div');
	row.className = 'row ' + cls;
	row.innerHTML = (label ? '<div class="row-label">' + label + '</div>' : '')
		+ '<div class="row-body">' + (bodyHtml || '') + '</div>';
	tl.appendChild(row);
	const nearBottom = log.scrollTop + log.clientHeight > log.scrollHeight - 120;
	if (nearBottom) log.scrollTop = log.scrollHeight;
	return row;
}

function thinking(){
	const tl = ensureTimeline();
	if (tl.querySelector('.row.thinking')) return;
	const row = document.createElement('div');
	row.className = 'row thinking';
	row.innerHTML = '<div class="row-body">thinking…</div>';
	tl.appendChild(row);
	log.scrollTop = log.scrollHeight;
}

function setRunning(on){
	running = on;
	runBtn.classList.toggle('running', on);
	runBtn.title = on ? 'Stop' : 'Run';
	runBtn.textContent = on ? '■' : '↑';
	dot.className = 'dot ' + (on ? 'run' : '');
	stateEl.textContent = on ? 'running' : 'idle';
}

function fmtArgs(input){
	if (input == null) return '';
	try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

function send(){
	if (running){ vscode.postMessage({ type: 'stop' }); return; }
	const t = input.value.trim();
	if (!t) return;
	input.value = '';
	appendRow('task', '<span>Task</span>', escapeHtml(t));
	vscode.postMessage({ type: 'run', text: t });
}

runBtn.onclick = send;
input.addEventListener('keydown', function(e){
	if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); }
});

window.addEventListener('message', function(e){
	const m = e.data;
	if (m.type === 'task') appendRow('task', '<span>Task</span>', escapeHtml(m.text));
	else if (m.type === 'thinking') thinking();
	else if (m.type === 'text') appendRow('text', '<span>Assistant</span>', escapeHtml(m.text).replace(/\\n/g, '<br>'));
	else if (m.type === 'tool_call'){
		appendRow('tool',
			'<span class="tool-icon">' + toolIcon(m.tool) + '</span><span>Tool</span>',
			'<span class="tool-name">' + escapeHtml(m.tool) + '</span>'
			+ '<div class="tool-args">' + escapeHtml(fmtArgs(m.input)) + '</div>'
		);
	}
	else if (m.type === 'tool_result'){
		const out = (m.output || '').toString();
		const trimmed = out.length > 280 ? out.slice(0, 280) + '…' : out;
		const row = appendRow('result',
			'<span>Result</span> <span style="opacity:.5">(' + (out.length || 0) + ' chars)</span>',
			'<div class="collapsible">'
			+   '<div class="collapsible-head"><span class="chev">▶</span><span>' + escapeHtml(trimmed.split('\\n')[0] || '(empty)') + '</span></div>'
			+   '<div class="collapsible-body">' + escapeHtml(out.slice(0, 8000)) + '</div>'
			+ '</div>'
		);
		const head = row.querySelector('.collapsible-head');
		head.addEventListener('click', function(){
			head.parentElement.classList.toggle('open');
		});
	}
	else if (m.type === 'checkpoint'){
		appendRow('checkpoint', '', '⎙ checkpoint ' + escapeHtml((m.checkpointId || '').slice(0, 8)));
	}
	else if (m.type === 'approval'){
		const tl = ensureTimeline();
		const removeThinking = tl.querySelector('.row.thinking');
		if (removeThinking) removeThinking.remove();
		const row = document.createElement('div');
		row.className = 'row approval';
		row.innerHTML = '<div class="row-label"><span>Approval needed</span></div>'
			+ '<div class="row-body"><div class="approval">'
			+   '<div class="a-title">' + escapeHtml(m.tool) + '</div>'
			+   '<div class="a-prev">' + escapeHtml(m.preview || '') + '</div>'
			+   '<div class="approval-actions">'
			+     '<button class="primary" data-a="ok">Approve</button>'
			+     '<button data-a="no">Reject</button>'
			+   '</div></div></div>';
		tl.appendChild(row);
		log.scrollTop = log.scrollHeight;
		row.querySelectorAll('.approval-actions button').forEach(function(b){
			b.onclick = function(){
				const a = b.getAttribute('data-a');
				vscode.postMessage({ type: a === 'ok' ? 'approve' : 'reject' });
				row.querySelector('.approval-actions').innerHTML =
					'<span style="opacity:.6;font-size:11px">' + (a === 'ok' ? 'approved' : 'rejected') + '</span>';
			};
		});
	}
	else if (m.type === 'done'){
		appendRow('done', '<span>Done</span>', '<span style="opacity:.6">agent finished</span>');
		dot.className = 'dot ok';
		stateEl.textContent = 'done';
	}
	else if (m.type === 'error'){
		appendRow('error', '<span>Error</span>', escapeHtml(m.text || 'unknown'));
		dot.className = 'dot err';
		stateEl.textContent = 'error';
	}
	else if (m.type === 'running') setRunning(!!m.on);
});
})();
</script></body></html>`;
	}
}
