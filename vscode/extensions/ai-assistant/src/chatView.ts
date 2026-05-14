import * as vscode from 'vscode';
import { stream, AnthropicMessage } from './anthropic';
import { loadRulesAndMemory } from './rules';
import { CodebaseIndex } from './codebaseIndex';
import { resolveMentions, formatMentions } from './mentions';
import { gatherForDocument, formatLspContext } from './lspContext';
import { telemetry } from './telemetry';
import { addMissingImports } from './autoImport';
import { smartApply } from './smartApply';
import { startRecording, stopAndTranscribe, isRecording } from './whisper';
import { recordTurn } from './pastChats';

const MODEL_OPTIONS: { id: string; label: string; hint: string; group: string }[] = [
	{ id: 'claude-opus-4-7', label: 'Opus 4.7', hint: 'most capable', group: 'Anthropic' },
	{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hint: 'balanced', group: 'Anthropic' },
	{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'fastest', group: 'Anthropic' },
	{ id: 'gpt-4o', label: 'GPT-4o', hint: 'OpenAI flagship', group: 'OpenAI' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o mini', hint: 'cheap & fast', group: 'OpenAI' },
	{ id: 'o3-mini', label: 'o3-mini', hint: 'reasoning', group: 'OpenAI' },
];

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'aiAssistant.chatView';
	private view?: vscode.WebviewView;
	private history: AnthropicMessage[] = [];
	private currentAbort: AbortController | undefined;
	private currentModel: string | undefined;
	constructor(private readonly extensionUri: vscode.Uri, private readonly index: CodebaseIndex) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage(async (msg) => {
			if (msg.type === 'send') { await this.handleSend(msg.text, msg.model, msg.images, !!msg.webSearch); }
			else if (msg.type === 'stop') { this.currentAbort?.abort(); }
			else if (msg.type === 'clear') { this.history = []; this.post({ type: 'cleared' }); }
			else if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); }
			else if (msg.type === 'insert') { await insertIntoActiveEditor(msg.text); }
			else if (msg.type === 'newFile') { await openAsUntitled(msg.text, msg.lang); }
			else if (msg.type === 'smartApply') { await smartApply(msg.text, msg.lang); }
			else if (msg.type === 'micToggle') {
				try {
					if (isRecording()) {
						this.post({ type: 'micState', recording: false, busy: true });
						const text = await stopAndTranscribe();
						this.post({ type: 'micState', recording: false, busy: false });
						if (text) { this.post({ type: 'transcript', text }); }
					} else {
						await startRecording();
						this.post({ type: 'micState', recording: true, busy: false });
					}
				} catch (e: any) {
					this.post({ type: 'micState', recording: false, busy: false });
					this.post({ type: 'error', text: 'Voice: ' + (e?.message ?? e) });
				}
			}
			else if (msg.type === 'pickImage') { await this.pickAndSendImage(); }
			else if (msg.type === 'ready') { this.post({ type: 'models', current: this.resolvedModel(), options: MODEL_OPTIONS }); }
		});
	}

	reveal(): void { this.view?.show?.(true); }

	private resolvedModel(): string {
		if (this.currentModel) { return this.currentModel; }
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		return cfg.get<string>('models.chat', 'claude-opus-4-7');
	}

	private async pickAndSendImage(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
		});
		if (!uris?.length) { return; }
		const fs = await import('fs/promises');
		const images: { mime: string; data: string }[] = [];
		for (const u of uris) {
			const buf = await fs.readFile(u.fsPath);
			const ext = u.fsPath.toLowerCase().split('.').pop() ?? 'png';
			const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
			images.push({ mime, data: buf.toString('base64') });
		}
		this.post({ type: 'imagesAttached', count: images.length, items: images });
	}

	private async handleSend(text: string, model?: string, images?: { mime: string; data: string }[], webSearch?: boolean): Promise<void> {
		if (model) { this.currentModel = model; }
		this.currentAbort?.abort();
		const ctrl = new AbortController();
		this.currentAbort = ctrl;

		const { resolved } = await resolveMentions(text);
		const mentionBlock = formatMentions(resolved);
		const editor = vscode.window.activeTextEditor;
		const rules = await loadRulesAndMemory();
		await this.index.ensureBuilt();
		const context = await this.index.formatContext(text, 5);

		let system = 'You are a helpful coding assistant inside an editor. Be concise. Use fenced code blocks (```lang) for code.';
		if (rules) { system += '\n\n' + rules; }
		if (editor) {
			const sel = editor.document.getText(editor.selection);
			if (sel.trim()) {
				system += `\n\nActive selection (${editor.document.languageId}, ${editor.document.fileName}):\n\`\`\`\n${sel}\n\`\`\``;
			}
			try {
				const lsp = await gatherForDocument(editor.document, editor.selection.active);
				const formatted = formatLspContext(lsp);
				if (formatted) { system += `\n\n# Editor LSP context\n${formatted}`; }
			} catch { /* skip */ }
		}
		if (context) { system += `\n\n# Likely-relevant code\n${context}`; }

		const userText = mentionBlock ? `${text}\n\n${mentionBlock}` : text;
		if (images && images.length) {
			const blocks: any[] = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } }));
			blocks.push({ type: 'text', text: userText });
			this.history.push({ role: 'user', content: blocks });
		} else {
			this.history.push({ role: 'user', content: userText });
		}

		const userId = 'u' + Date.now();
		const asstId = 'a' + (Date.now() + 1);
		this.post({ type: 'message', id: userId, role: 'user', text });
		this.post({ type: 'message', id: asstId, role: 'assistant', text: '' });
		this.post({ type: 'streaming', on: true });

		let collected = '';
		try {
			const gen = stream({ system, messages: this.history, maxTokens: 2048, task: 'chat', model: this.resolvedModel(), webSearch, signal: ctrl.signal });
			while (true) {
				const { done, value } = await gen.next();
				if (done) { break; }
				if (value.type === 'text_delta' && value.text) {
					collected += value.text;
					this.post({ type: 'delta', id: asstId, text: value.text });
				} else if (value.type === 'error') {
					this.post({ type: 'error', text: value.error ?? 'unknown' });
				}
			}
			this.history.push({ role: 'assistant', content: collected });
			void recordTurn(text, collected);
			telemetry.track('chat.send', { chars: text.length });
		} catch (err: any) {
			telemetry.error('chat.send', err);
			this.post({ type: 'error', text: String(err?.message ?? err) });
		} finally {
			this.post({ type: 'streaming', on: false });
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
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-sideBar-background, var(--vscode-editor-background));
	display: flex; flex-direction: column; height: 100vh;
}
.header {
	display: flex; align-items: center; justify-content: space-between;
	padding: 6px 10px; border-bottom: 1px solid var(--border);
	flex-shrink: 0; height: 30px;
}
.header-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .6px; opacity: .85; }
.header-actions { display: flex; gap: 6px; align-items: center; }
.model-picker {
	background: transparent;
	color: inherit;
	border: 1px solid var(--border);
	border-radius: 4px;
	padding: 2px 6px;
	font-size: 11px;
	font-family: inherit;
	cursor: pointer;
	max-width: 130px;
}
.model-picker:hover { background: var(--hover); }
.model-picker:focus { outline: 1px solid var(--accent); }
.icon-btn {
	background: transparent; border: none; color: inherit;
	width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
	display: inline-flex; align-items: center; justify-content: center;
	font-size: 13px; opacity: .65;
}
.icon-btn:hover { background: var(--hover); opacity: 1; }

#log {
	flex: 1; overflow-y: auto; padding: 14px 12px;
	display: flex; flex-direction: column; gap: 18px;
}
#log::-webkit-scrollbar { width: 8px; }
#log::-webkit-scrollbar-thumb { background: rgba(127,127,127,.25); border-radius: 4px; }

.empty {
	display: flex; flex-direction: column; align-items: stretch; justify-content: center;
	flex: 1; padding: 12px 4px; text-align: center; opacity: .9;
}
.empty .logo {
	font-size: 22px; margin-bottom: 6px; opacity: .6;
}
.empty h3 { margin: 0 0 4px; font-weight: 500; font-size: 13px; }
.empty p { margin: 0 0 14px; font-size: 11px; opacity: .65; }
.examples { display: flex; flex-direction: column; gap: 6px; }
.example {
	padding: 8px 10px; border: 1px solid var(--border);
	border-radius: 6px; cursor: pointer; font-size: 12px;
	text-align: left; background: transparent; color: inherit;
	transition: background .12s;
}
.example:hover { background: var(--hover); border-color: var(--accent); }
.example .ex-title { font-weight: 500; margin-bottom: 2px; }
.example .ex-sub { opacity: .6; font-size: 11px; }

.msg {
	display: flex; gap: 9px; align-items: flex-start;
	animation: fadeIn .18s ease;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
.avatar {
	width: 22px; height: 22px; border-radius: 50%;
	flex-shrink: 0; display: inline-flex; align-items: center;
	justify-content: center; font-size: 10px; font-weight: 700;
	margin-top: 1px;
}
.msg.user .avatar { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.assistant .avatar {
	background: linear-gradient(135deg, var(--vscode-textLink-foreground), var(--vscode-button-background));
	color: var(--vscode-editor-background);
}
.bubble { flex: 1; min-width: 0; line-height: 1.55; word-wrap: break-word; padding-top: 1px; }
.bubble > *:first-child { margin-top: 0; }
.bubble > *:last-child { margin-bottom: 0; }
.bubble p { margin: 0 0 8px; }
.bubble h1, .bubble h2, .bubble h3 { margin: 12px 0 6px; font-weight: 600; }
.bubble h1 { font-size: 1.2em; } .bubble h2 { font-size: 1.1em; } .bubble h3 { font-size: 1em; }
.bubble ul, .bubble ol { padding-left: 22px; margin: 4px 0 8px; }
.bubble li { margin: 2px 0; }
.bubble code:not(pre code) {
	background: var(--code-bg); padding: 1px 5px;
	border-radius: 3px; font-family: var(--vscode-editor-font-family);
	font-size: .92em;
}
.bubble a { color: var(--accent); text-decoration: none; }
.bubble a:hover { text-decoration: underline; }
.bubble blockquote {
	border-left: 3px solid var(--border); padding: 0 10px;
	margin: 6px 0; opacity: .85; color: var(--muted);
}

.codeblock {
	border: 1px solid var(--border); border-radius: 6px;
	overflow: hidden; margin: 8px 0; background: var(--code-bg);
}
.codeblock-header {
	display: flex; align-items: center; justify-content: space-between;
	padding: 4px 6px 4px 10px; background: rgba(127,127,127,.07);
	border-bottom: 1px solid var(--border); font-size: 11px;
}
.codeblock-lang { opacity: .65; font-family: var(--vscode-editor-font-family); }
.codeblock-actions { display: flex; gap: 2px; }
.codeblock-actions button {
	background: transparent; border: none; color: inherit;
	padding: 3px 8px; border-radius: 3px; cursor: pointer;
	font-size: 11px; opacity: .65;
}
.codeblock-actions button:hover { background: var(--hover); opacity: 1; }
.codeblock pre {
	margin: 0; padding: 10px 12px; overflow-x: auto;
	font-family: var(--vscode-editor-font-family);
	font-size: var(--vscode-editor-font-size, 12px);
	line-height: 1.45; white-space: pre;
}

.cursor {
	display: inline-block; width: 7px; height: 14px;
	background: currentColor; opacity: .65; vertical-align: text-bottom;
	margin-left: 2px; animation: blink 1s steps(2) infinite;
}
@keyframes blink { 50% { opacity: 0; } }

.err {
	background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.1));
	color: var(--vscode-inputValidation-errorForeground, inherit);
	border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255,0,0,.4));
	padding: 6px 10px; border-radius: 4px; font-size: 12px;
}

.input-area {
	padding: 8px 10px 10px; border-top: 1px solid var(--border);
	flex-shrink: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
.mention-hint {
	font-size: 10px; opacity: .5; margin-bottom: 5px;
	font-family: var(--vscode-editor-font-family);
}
.attachments { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.attachments .chip {
	background: var(--code-bg); padding: 3px 8px; border-radius: 999px;
	font-size: 11px; cursor: pointer; user-select: none;
}
.attachments .chip:hover { background: var(--hover); }
.input-wrap {
	display: flex; align-items: flex-end; gap: 6px;
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--border));
	border-radius: 6px; padding: 6px 8px;
	transition: border-color .12s;
}
.input-wrap:focus-within { border-color: var(--vscode-focusBorder, var(--accent)); }
#input {
	flex: 1; background: transparent; color: var(--vscode-input-foreground);
	border: none; outline: none; resize: none;
	font-family: inherit; font-size: 13px; line-height: 1.4;
	max-height: 200px; min-height: 20px; padding: 2px 0;
}
.send-btn {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none; border-radius: 4px;
	width: 26px; height: 24px; cursor: pointer;
	display: inline-flex; align-items: center; justify-content: center;
	font-size: 13px; flex-shrink: 0;
}
.send-btn:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.send-btn.streaming { background: var(--vscode-errorForeground, #c33); }
</style></head><body>
<div class="header">
	<div class="header-title">Chat</div>
	<div class="header-actions">
		<select class="model-picker" id="modelPicker" title="Model"></select>
		<button class="icon-btn" id="websearch" title="Toggle web search">🌐</button>
		<button class="icon-btn" id="clear" title="Clear conversation">⟲</button>
	</div>
</div>
<div id="log"></div>
<div class="input-area">
	<div class="mention-hint">@codebase · @past_chats · @file · @symbol · @git · @selection · @docs · @notepad</div>
	<div id="attachments" class="attachments"></div>
	<div class="input-wrap">
		<textarea id="input" rows="1" placeholder="Ask anything — Enter to send, Shift+Enter for newline"></textarea>
		<button class="send-btn" id="attach" title="Attach image">📎</button>
		<button class="send-btn" id="mic" title="Voice input (Whisper)">🎤</button>
		<button class="send-btn" id="send" title="Send">↑</button>
	</div>
</div>

<script nonce="${nonce}">
(function(){
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const modelPicker = document.getElementById('modelPicker');
let streaming = false;
let selectedModel = '';
const messages = new Map();

vscode.postMessage({ type: 'ready' });
renderEmpty();

modelPicker.addEventListener('change', function(){ selectedModel = modelPicker.value; });

function renderEmpty(){
	const wrap = document.createElement('div');
	wrap.className = 'empty';
	wrap.innerHTML = ''
		+ '<div class="logo">✦</div>'
		+ '<h3>AI Assistant</h3>'
		+ '<p>Streaming chat with codebase context, mentions, and rules.</p>'
		+ '<div class="examples">'
		+   '<button class="example" data-q="Explain what the active file does"><div class="ex-title">Explain this file</div><div class="ex-sub">summarize the active editor</div></button>'
		+   '<button class="example" data-q="Find any bugs or issues in @selection"><div class="ex-title">Review selection</div><div class="ex-sub">requires text selected in editor</div></button>'
		+   '<button class="example" data-q="What does @file:src/extension.ts do?"><div class="ex-title">Ask about a file</div><div class="ex-sub">@file:path</div></button>'
		+ '</div>';
	log.appendChild(wrap);
	wrap.querySelectorAll('.example').forEach(function(b){
		b.addEventListener('click', function(){
			input.value = b.getAttribute('data-q'); resizeInput(); input.focus();
		});
	});
}

function clearEmpty(){ const e = log.querySelector('.empty'); if (e) e.remove(); }

function escapeHtml(s){
	return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderMarkdown(src, isStreaming){
	if (!src) return isStreaming ? '<span class="cursor"></span>' : '';
	var out = '';
	var i = 0;
	while (i < src.length){
		var fence = src.indexOf('\\\`\\\`\\\`', i);
		if (fence === -1){ out += renderInline(src.slice(i)); break; }
		out += renderInline(src.slice(i, fence));
		var rest = src.slice(fence + 3);
		var close = rest.indexOf('\\\`\\\`\\\`');
		var body, isClosed;
		if (close === -1){ body = rest; isClosed = false; i = src.length; }
		else { body = rest.slice(0, close); isClosed = true; i = fence + 3 + close + 3; }
		var nl = body.indexOf('\\n');
		var lang = nl >= 0 ? body.slice(0, nl).trim() : '';
		var code = nl >= 0 ? body.slice(nl + 1) : body;
		out += '<div class="codeblock"><div class="codeblock-header">'
			+ '<span class="codeblock-lang">' + escapeHtml(lang || 'code') + '</span>'
			+ '<div class="codeblock-actions">'
			+   '<button data-act="copy">Copy</button>'
			+   '<button data-act="insert">Insert</button>'
			+   '<button data-act="apply" data-lang="' + escapeHtml(lang) + '" title="AI-merge into active file">Smart Apply</button>'
			+   '<button data-act="newFile" data-lang="' + escapeHtml(lang) + '">New File</button>'
			+ '</div></div>'
			+ '<pre>' + escapeHtml(code) + '</pre></div>';
		if (!isClosed) break;
	}
	if (isStreaming) out += '<span class="cursor"></span>';
	return out;
}

function renderInline(s){
	if (!s) return '';
	var parts = s.split(/(\\\`[^\\\`\\n]+\\\`)/g);
	var out = '';
	for (var j = 0; j < parts.length; j++){
		var p = parts[j];
		if (p.charAt(0) === '\\\`' && p.charAt(p.length-1) === '\\\`'){
			out += '<code>' + escapeHtml(p.slice(1,-1)) + '</code>';
		} else {
			var t = escapeHtml(p);
			t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
			t = t.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<i>$2</i>');
			t = t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
			t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>');
			t = t.replace(/^## (.+)$/gm, '<h2>$1</h2>');
			t = t.replace(/^# (.+)$/gm, '<h1>$1</h1>');
			t = t.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
			t = t.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
			t = t.replace(/(<li>[\\s\\S]*?<\\/li>(?:\\s*<li>[\\s\\S]*?<\\/li>)*)/g, '<ul>$1</ul>');
			t = t.replace(/\\n/g, '<br>');
			out += t;
		}
	}
	return out;
}

function attachCodeActions(container){
	var blocks = container.querySelectorAll('.codeblock');
	for (var i = 0; i < blocks.length; i++){
		(function(block){
			var pre = block.querySelector('pre');
			var btns = block.querySelectorAll('.codeblock-actions button');
			for (var j = 0; j < btns.length; j++){
				(function(btn){
					btn.onclick = function(){
						var code = pre.textContent;
						var act = btn.getAttribute('data-act');
						if (act === 'copy'){
							vscode.postMessage({ type: 'copy', text: code });
							var orig = btn.textContent;
							btn.textContent = 'Copied';
							setTimeout(function(){ btn.textContent = orig; }, 1100);
						} else if (act === 'insert'){
							vscode.postMessage({ type: 'insert', text: code });
						} else if (act === 'apply'){
							vscode.postMessage({ type: 'smartApply', text: code, lang: btn.getAttribute('data-lang') || '' });
						} else if (act === 'newFile'){
							vscode.postMessage({ type: 'newFile', text: code, lang: btn.getAttribute('data-lang') || '' });
						}
					};
				})(btns[j]);
			}
		})(blocks[i]);
	}
}

function addMessage(id, role, text){
	clearEmpty();
	var wrap = document.createElement('div');
	wrap.className = 'msg ' + role;
	wrap.setAttribute('data-id', id);
	var av = document.createElement('div');
	av.className = 'avatar';
	av.textContent = role === 'user' ? 'You' : 'AI';
	if (role === 'user') av.textContent = 'U';
	var bubble = document.createElement('div');
	bubble.className = 'bubble';
	bubble.innerHTML = renderMarkdown(text, role === 'assistant' && streaming);
	wrap.appendChild(av); wrap.appendChild(bubble);
	log.appendChild(wrap);
	messages.set(id, { el: wrap, bubble: bubble, raw: text || '', role: role });
	attachCodeActions(bubble);
	log.scrollTop = log.scrollHeight;
}

var pendingRender = false;
function appendDelta(id, chunk){
	var m = messages.get(id);
	if (!m) return;
	m.raw += chunk;
	if (!pendingRender){
		pendingRender = true;
		requestAnimationFrame(function(){
			pendingRender = false;
			m.bubble.innerHTML = renderMarkdown(m.raw, streaming);
			attachCodeActions(m.bubble);
			var nearBottom = log.scrollTop + log.clientHeight > log.scrollHeight - 120;
			if (nearBottom) log.scrollTop = log.scrollHeight;
		});
	}
}

function setStreaming(on){
	streaming = on;
	sendBtn.classList.toggle('streaming', on);
	sendBtn.title = on ? 'Stop' : 'Send';
	sendBtn.textContent = on ? '■' : '↑';
	if (!on){
		messages.forEach(function(m){
			if (m.role === 'assistant'){
				m.bubble.innerHTML = renderMarkdown(m.raw, false);
				attachCodeActions(m.bubble);
			}
		});
	}
}

var pendingImages = [];
var webSearchOn = false;
var wsBtn = document.getElementById('websearch');
wsBtn.onclick = function(){
	webSearchOn = !webSearchOn;
	wsBtn.style.opacity = webSearchOn ? '1' : '0.5';
	wsBtn.title = webSearchOn ? 'Web search ON' : 'Toggle web search';
};
wsBtn.style.opacity = '0.5';
function renderAttachments(){
	var box = document.getElementById('attachments');
	box.innerHTML = '';
	pendingImages.forEach(function(im, i){
		var chip = document.createElement('span');
		chip.className = 'chip';
		chip.textContent = '🖼 image ' + (i+1) + ' ✕';
		chip.onclick = function(){ pendingImages.splice(i, 1); renderAttachments(); };
		box.appendChild(chip);
	});
}

function send(){
	if (streaming){ vscode.postMessage({ type: 'stop' }); return; }
	var t = input.value.trim();
	if (!t && !pendingImages.length) return;
	input.value = ''; resizeInput();
	var imgs = pendingImages.slice();
	pendingImages = []; renderAttachments();
	vscode.postMessage({ type: 'send', text: t, model: selectedModel || undefined, images: imgs, webSearch: webSearchOn });
}

function resizeInput(){
	input.style.height = 'auto';
	input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

sendBtn.onclick = send;
document.getElementById('attach').onclick = function(){
	vscode.postMessage({ type: 'pickImage' });
};

var micBtn = document.getElementById('mic');
micBtn.onclick = function(){ vscode.postMessage({ type: 'micToggle' }); };
document.getElementById('clear').onclick = function(){
	log.innerHTML = ''; messages.clear();
	renderEmpty();
	vscode.postMessage({ type: 'clear' });
};
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', function(e){
	if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); }
});
input.focus();

window.addEventListener('message', function(e){
	var m = e.data;
	if (m.type === 'models'){
		modelPicker.innerHTML = '';
		(m.options || []).forEach(function(opt){
			var o = document.createElement('option');
			o.value = opt.id;
			o.textContent = opt.label + ' · ' + opt.hint;
			if (opt.id === m.current) o.selected = true;
			modelPicker.appendChild(o);
		});
		selectedModel = m.current || '';
	}
	else if (m.type === 'message') addMessage(m.id, m.role, m.text || '');
	else if (m.type === 'delta') appendDelta(m.id, m.text);
	else if (m.type === 'streaming') setStreaming(!!m.on);
	else if (m.type === 'error'){
		clearEmpty();
		var el = document.createElement('div'); el.className = 'err'; el.textContent = m.text;
		log.appendChild(el); log.scrollTop = log.scrollHeight;
	}
	else if (m.type === 'cleared'){ log.innerHTML = ''; messages.clear(); renderEmpty(); }
	else if (m.type === 'imagesAttached'){
		(m.items || []).forEach(function(it){ pendingImages.push(it); });
		renderAttachments();
	}
	else if (m.type === 'transcript'){
		var t = (m.text || '').trim();
		if (!t) return;
		input.value = (input.value ? input.value + ' ' : '') + t;
		resizeInput();
		input.focus();
	}
	else if (m.type === 'micState'){
		if (m.busy){
			micBtn.textContent = '⏳';
			micBtn.style.background = '';
			micBtn.title = 'Transcribing...';
		} else if (m.recording){
			micBtn.textContent = '⏹';
			micBtn.style.background = 'rgba(229, 57, 53, 0.6)';
			micBtn.title = 'Click to stop & transcribe';
		} else {
			micBtn.textContent = '🎤';
			micBtn.style.background = '';
			micBtn.title = 'Voice input (Whisper)';
		}
	}
});
})();
</script></body></html>`;
	}
}

async function insertIntoActiveEditor(text: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		await openAsUntitled(text, '');
		return;
	}
	await editor.edit(eb => {
		if (editor.selection.isEmpty) { eb.insert(editor.selection.active, text); }
		else { eb.replace(editor.selection, text); }
	});
	await addMissingImports(editor.document.uri);
}

async function openAsUntitled(text: string, lang: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({ content: text, language: lang || undefined });
	await vscode.window.showTextDocument(doc);
}
