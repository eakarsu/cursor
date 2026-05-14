import * as vscode from 'vscode';

const FIELDS: { key: string; label: string; type: 'string' | 'boolean' | 'select'; options?: string[]; secret?: boolean; help?: string }[] = [
	{ key: 'backend', label: 'Backend', type: 'select', options: ['api', 'claudeCode'], help: '"claudeCode" uses your Max/Pro subscription via the CLI.' },
	{ key: 'apiKey', label: 'Anthropic API Key', type: 'string', secret: true, help: 'Used when backend = api.' },
	{ key: 'openaiApiKey', label: 'OpenAI API Key', type: 'string', secret: true },
	{ key: 'voyageApiKey', label: 'Voyage Embeddings Key', type: 'string', secret: true },
	{ key: 'claudeCli', label: 'Claude CLI binary', type: 'string', help: 'Path to claude. Default: claude (resolved from PATH).' },
	{ key: 'models.chat', label: 'Chat / Agent model', type: 'string' },
	{ key: 'models.cmdK', label: 'Cmd-K model', type: 'string' },
	{ key: 'models.completions', label: 'Completions / Tab model', type: 'string' },
	{ key: 'inlineCompletions.enabled', label: 'Inline completions', type: 'boolean' },
	{ key: 'tabPrediction.enabled', label: 'Tab prediction', type: 'boolean' },
	{ key: 'codebaseIndex.enabled', label: 'Codebase index', type: 'boolean' },
	{ key: 'agent.claudeCodeAutoApprove', label: 'Auto-approve agent tools (Max mode)', type: 'boolean' },
	{ key: 'agent.allowedTools', label: 'Agent allowed tools (CSV)', type: 'string' },
	{ key: 'privacyMode', label: 'Privacy mode (no cloud, no telemetry, no index ctx)', type: 'boolean' },
	{ key: 'telemetry.enabled', label: 'Telemetry', type: 'boolean' },
	{ key: 'cloudEndpoint', label: 'Cloud endpoint', type: 'string' },
	{ key: 'tabModelEndpoint', label: 'Tab model endpoint (OpenAI-compatible)', type: 'string' },
];

export function registerSettingsView(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.openSettings', () => showSettings(context)),
	);
}

function showSettings(context: vscode.ExtensionContext): void {
	const panel = vscode.window.createWebviewPanel(
		'aiAssistant.settings',
		'AI Assistant Settings',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = renderHtml();
	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg.type === 'ready') {
			panel.webview.postMessage({ type: 'values', values: collectValues(), fields: FIELDS });
		} else if (msg.type === 'set') {
			const cfg = vscode.workspace.getConfiguration('aiAssistant');
			await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
			panel.webview.postMessage({ type: 'saved', key: msg.key });
		} else if (msg.type === 'test') {
			const result = await testBackend();
			panel.webview.postMessage({ type: 'testResult', ok: result.ok, msg: result.msg });
		}
	}, undefined, context.subscriptions);
}

function collectValues(): Record<string, any> {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const out: Record<string, any> = {};
	for (const f of FIELDS) { out[f.key] = cfg.get(f.key); }
	return out;
}

async function testBackend(): Promise<{ ok: boolean; msg: string }> {
	try {
		const { call } = await import('./anthropic');
		const r = await call({ messages: [{ role: 'user', content: 'reply with OK' }], maxTokens: 20 });
		return { ok: true, msg: `Got: ${r.text.slice(0, 50)}` };
	} catch (e: any) {
		return { ok: false, msg: e?.message ?? String(e) };
	}
}

function renderHtml(): string {
	const nonce = String(Date.now());
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body { font-family: var(--vscode-font-family); padding: 24px; max-width: 720px; margin: 0 auto; color: var(--vscode-foreground); }
h1 { margin: 0 0 4px; font-size: 22px; }
.sub { color: var(--vscode-descriptionForeground); margin-bottom: 24px; font-size: 13px; }
.row { display: grid; grid-template-columns: 1fr; gap: 4px; margin-bottom: 18px; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
.row label { font-weight: 600; font-size: 13px; }
.row .help { color: var(--vscode-descriptionForeground); font-size: 11px; }
.row input, .row select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px 8px; border-radius: 3px; font: inherit; }
.row input[type=checkbox] { width: 16px; height: 16px; }
.saved { color: var(--vscode-testing-iconPassed, #4ade80); font-size: 11px; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 6px 14px; border-radius: 3px; cursor: pointer; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
.test-result { margin-top: 8px; padding: 8px; border-radius: 4px; font-size: 12px; }
.test-result.ok { background: rgba(74, 222, 128, .1); }
.test-result.err { background: rgba(229, 57, 53, .1); }
</style></head><body>
<h1>AI Assistant Settings</h1>
<div class="sub">Changes save automatically. Use the Anthropic key for direct API; switch to "claudeCode" backend to use your Max/Pro subscription.</div>
<div id="form"></div>
<div class="actions">
	<button id="test">Test connection</button>
</div>
<div id="testResult"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const form = document.getElementById('form');
vscode.postMessage({ type: 'ready' });

window.addEventListener('message', (e) => {
	const m = e.data;
	if (m.type === 'values') {
		form.innerHTML = '';
		(m.fields || []).forEach((f) => form.appendChild(renderField(f, m.values[f.key])));
	} else if (m.type === 'saved') {
		const tag = document.querySelector('[data-key="' + m.key + '"] .saved');
		if (tag) { tag.textContent = '✓ saved'; setTimeout(() => tag.textContent = '', 1500); }
	} else if (m.type === 'testResult') {
		const r = document.getElementById('testResult');
		r.className = 'test-result ' + (m.ok ? 'ok' : 'err');
		r.textContent = (m.ok ? '✓ ' : '✕ ') + m.msg;
	}
});

function renderField(f, value) {
	const row = document.createElement('div');
	row.className = 'row'; row.setAttribute('data-key', f.key);
	const lbl = document.createElement('label'); lbl.textContent = f.label;
	row.appendChild(lbl);
	if (f.help) { const h = document.createElement('div'); h.className = 'help'; h.textContent = f.help; row.appendChild(h); }
	let input;
	if (f.type === 'boolean') {
		input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!value;
		input.addEventListener('change', () => save(f.key, input.checked));
	} else if (f.type === 'select') {
		input = document.createElement('select');
		(f.options || []).forEach(opt => { const o = document.createElement('option'); o.value = opt; o.textContent = opt; if (opt === value) o.selected = true; input.appendChild(o); });
		input.addEventListener('change', () => save(f.key, input.value));
	} else {
		input = document.createElement('input'); input.type = f.secret ? 'password' : 'text'; input.value = value || '';
		input.addEventListener('change', () => save(f.key, input.value));
	}
	row.appendChild(input);
	const saved = document.createElement('span'); saved.className = 'saved'; row.appendChild(saved);
	return row;
}
function save(key, value) { vscode.postMessage({ type: 'set', key, value }); }
document.getElementById('test').onclick = () => {
	document.getElementById('testResult').textContent = 'Testing...';
	vscode.postMessage({ type: 'test' });
};
</script></body></html>`;
}
