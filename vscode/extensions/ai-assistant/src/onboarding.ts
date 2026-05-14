import * as vscode from 'vscode';

const FLAG = 'aiAssistant.onboarded';

export function maybeShow(context: vscode.ExtensionContext): void {
	if (context.globalState.get<boolean>(FLAG)) { return; }
	void show(context);
}

export async function show(context: vscode.ExtensionContext): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		'aiAssistant.onboarding',
		'Welcome to AI Assistant',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = html();
	panel.webview.onDidReceiveMessage(async (msg) => {
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		try {
			if (msg.type === 'save') {
				if (typeof msg.anthropicKey === 'string' && msg.anthropicKey) {
					await cfg.update('apiKey', msg.anthropicKey, vscode.ConfigurationTarget.Global);
				}
				if (typeof msg.openaiKey === 'string' && msg.openaiKey) {
					await cfg.update('openaiApiKey', msg.openaiKey, vscode.ConfigurationTarget.Global);
				}
				if (typeof msg.voyageKey === 'string' && msg.voyageKey) {
					await cfg.update('voyageApiKey', msg.voyageKey, vscode.ConfigurationTarget.Global);
				}
				if (msg.backend === 'api' || msg.backend === 'claudeCode') {
					await cfg.update('backend', msg.backend, vscode.ConfigurationTarget.Global);
				}
				if (typeof msg.privacy === 'boolean') {
					await cfg.update('privacyMode', msg.privacy, vscode.ConfigurationTarget.Global);
				}
				await context.globalState.update(FLAG, true);
				panel.webview.postMessage({ type: 'saved' });
			} else if (msg.type === 'finish') {
				await context.globalState.update(FLAG, true);
				panel.dispose();
				if (msg.reindex) {
					await vscode.commands.executeCommand('aiAssistant.indexWorkspace');
				}
			} else if (msg.type === 'skip') {
				await context.globalState.update(FLAG, true);
				panel.dispose();
			}
		} catch (e: any) {
			panel.webview.postMessage({ type: 'error', text: e?.message ?? String(e) });
		}
	});
}

function html(): string {
	const nonce = String(Date.now());
	return `<!doctype html><html><head><meta charset="utf-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px; max-width: 720px; margin: 0 auto; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 16px; margin: 28px 0 8px; }
p { color: var(--vscode-descriptionForeground); line-height: 1.5; }
label { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin: 12px 0 4px; }
input[type=text], input[type=password] { width: 100%; padding: 8px 10px; box-sizing: border-box; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; }
.row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
button { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.actions { display: flex; gap: 8px; margin-top: 24px; justify-content: flex-end; }
.toast { padding: 8px 12px; background: var(--vscode-inputValidation-infoBackground); border-radius: 4px; margin: 12px 0; display: none; }
.toast.show { display: block; }
.toast.err { background: var(--vscode-inputValidation-errorBackground); }
small { color: var(--vscode-descriptionForeground); }
</style></head>
<body>
<h1>Welcome to AI Assistant</h1>
<p>Let's get you set up in under a minute. You can change anything later in Settings.</p>

<h2>1 · How will you reach Anthropic?</h2>
<div class="row">
	<label><input type="radio" name="backend" value="api" checked> API key (sk-ant-…)</label>
</div>
<div class="row">
	<label><input type="radio" name="backend" value="claudeCode"> Claude Code CLI (use Max/Pro subscription, no API credits)</label>
</div>

<h2>2 · API keys</h2>
<small>Required for the API backend. Skip if you'll use Claude Code CLI.</small>
<label>Anthropic API key</label>
<input id="anthropicKey" type="password" placeholder="sk-ant-..." />
<label>OpenAI API key (optional — fallback routing, voice, embeddings)</label>
<input id="openaiKey" type="password" placeholder="sk-..." />
<label>Voyage API key (optional — best embeddings for code search)</label>
<input id="voyageKey" type="password" placeholder="pa-..." />

<h2>3 · Privacy</h2>
<div class="row">
	<label><input type="checkbox" id="privacy"> Enable privacy mode (disable cloud sync, telemetry, codebase context attachments)</label>
</div>

<h2>4 · Codebase index</h2>
<div class="row">
	<label><input type="checkbox" id="reindex" checked> Index workspace now (BM25 + embeddings if a key is provided)</label>
</div>

<div class="toast" id="toast"></div>

<div class="actions">
	<button class="secondary" id="skip">Skip</button>
	<button id="finish">Finish</button>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const toast = document.getElementById('toast');
function flash(msg, err){ toast.textContent = msg; toast.className = 'toast show' + (err ? ' err' : ''); setTimeout(function(){ toast.className = 'toast'; }, 2400); }
document.getElementById('finish').onclick = function(){
	const backend = (document.querySelector('input[name=backend]:checked') || {}).value || 'api';
	vscode.postMessage({
		type: 'save',
		backend: backend,
		anthropicKey: document.getElementById('anthropicKey').value.trim(),
		openaiKey: document.getElementById('openaiKey').value.trim(),
		voyageKey: document.getElementById('voyageKey').value.trim(),
		privacy: document.getElementById('privacy').checked,
	});
	const reindex = document.getElementById('reindex').checked;
	setTimeout(function(){ vscode.postMessage({ type: 'finish', reindex: reindex }); }, 200);
};
document.getElementById('skip').onclick = function(){ vscode.postMessage({ type: 'skip' }); };
window.addEventListener('message', function(e){
	if (e.data.type === 'saved') flash('Saved.');
	else if (e.data.type === 'error') flash(e.data.text || 'Error', true);
});
</script>
</body></html>`;
}
