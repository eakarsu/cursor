import * as vscode from 'vscode';
import { Auth } from './auth';

interface UsageInfo {
	plan: string;
	user: string;
	requestsThisMonth?: number;
	requestsLimit?: number;
	tokensThisMonth?: number;
	resetsAt?: string;
}

export async function showBilling(auth: Auth): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		'aiAssistant.billing',
		'AI: Billing & Usage',
		vscode.ViewColumn.Active,
		{ enableScripts: true },
	);
	const session = auth.current();
	let usage: UsageInfo | undefined;
	if (session) {
		usage = await fetchUsage(session.token).catch(() => undefined);
		if (!usage) {
			usage = { plan: session.plan ?? 'Free', user: session.user };
		}
	}
	panel.webview.html = render(usage);
	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg.type === 'manage') {
			const cfg = vscode.workspace.getConfiguration('aiAssistant');
			const endpoint = cfg.get<string>('cloudEndpoint');
			if (!endpoint) { vscode.window.showWarningMessage('Set aiAssistant.cloudEndpoint to manage your subscription.'); return; }
			await vscode.env.openExternal(vscode.Uri.parse(`${endpoint.replace(/\/$/, '')}/billing`));
		} else if (msg.type === 'signIn') {
			await vscode.commands.executeCommand('aiAssistant.signIn');
			panel.dispose();
			void showBilling(auth);
		}
	});
}

async function fetchUsage(token: string): Promise<UsageInfo | undefined> {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const endpoint = cfg.get<string>('cloudEndpoint');
	if (!endpoint) { return undefined; }
	try {
		const res = await fetch(`${endpoint.replace(/\/$/, '')}/billing/usage`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!res.ok) { return undefined; }
		return await res.json() as UsageInfo;
	} catch { return undefined; }
}

function render(usage: UsageInfo | undefined): string {
	const nonce = String(Date.now());
	if (!usage) {
		return `<!doctype html><html><body style="font-family:-apple-system,sans-serif;padding:32px;color:var(--vscode-foreground);background:var(--vscode-editor-background);">
		<h1 style="margin:0 0 8px">Billing & Usage</h1>
		<p style="color:var(--vscode-descriptionForeground)">Sign in to view your plan and usage.</p>
		<button onclick="acquireVsCodeApi().postMessage({type:'signIn'})" style="padding:8px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer">Sign in</button>
		</body></html>`;
	}
	const used = usage.requestsThisMonth ?? 0;
	const limit = usage.requestsLimit ?? 0;
	const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
	return `<!doctype html><html><head><style>
body { font-family:-apple-system,sans-serif; padding:32px; color:var(--vscode-foreground); background:var(--vscode-editor-background); max-width: 640px; }
h1 { margin: 0 0 4px; font-size: 24px; }
.muted { color: var(--vscode-descriptionForeground); }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; margin: 16px 0; }
.bar { height: 8px; background: var(--vscode-input-background); border-radius: 4px; overflow: hidden; margin-top: 8px; }
.bar > div { height: 100%; background: var(--vscode-progressBar-background); transition: width .3s; }
button { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
.row { display: flex; justify-content: space-between; align-items: center; margin: 8px 0; }
</style></head><body>
<h1>Billing & Usage</h1>
<div class="muted">Signed in as <b>${esc(usage.user)}</b></div>

<div class="card">
	<div class="row"><div>Plan</div><div><b>${esc(usage.plan)}</b></div></div>
	<div class="row"><div>Requests this month</div><div>${used}${limit ? ' / ' + limit : ''}</div></div>
	${limit ? `<div class="bar"><div style="width:${pct}%"></div></div>` : ''}
	${usage.tokensThisMonth != null ? `<div class="row"><div>Tokens this month</div><div>${usage.tokensThisMonth.toLocaleString()}</div></div>` : ''}
	${usage.resetsAt ? `<div class="row muted"><div>Resets</div><div>${esc(usage.resetsAt)}</div></div>` : ''}
</div>

<button onclick="acquireVsCodeApi().postMessage({type:'manage'})">Manage subscription</button>
<script nonce="${nonce}"></script>
</body></html>`;
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}
