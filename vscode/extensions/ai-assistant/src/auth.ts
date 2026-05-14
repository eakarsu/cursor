import * as vscode from 'vscode';

const SECRET_KEY = 'aiAssistant.token';

export interface Session { token: string; user: string; plan?: string; }

export class Auth {
	private session: Session | undefined;
	constructor(private context: vscode.ExtensionContext) { }

	async restore(): Promise<Session | undefined> {
		const raw = await this.context.secrets.get(SECRET_KEY);
		if (!raw) { return undefined; }
		try { this.session = JSON.parse(raw); } catch { return undefined; }
		return this.session;
	}

	current(): Session | undefined { return this.session; }

	async signIn(): Promise<Session | undefined> {
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		const endpoint = cfg.get<string>('cloudEndpoint');
		if (!endpoint) {
			vscode.window.showErrorMessage('Set aiAssistant.cloudEndpoint to use sign-in.');
			return undefined;
		}
		const startUrl = `${endpoint.replace(/\/$/, '')}/auth/start?client=vscode`;
		const codeP = vscode.window.showInputBox({
			prompt: 'After authorizing in browser, paste the code',
			placeHolder: 'code from /auth/callback',
			ignoreFocusOut: true,
		});
		await vscode.env.openExternal(vscode.Uri.parse(startUrl));
		const code = await codeP;
		if (!code) { return undefined; }
		const res = await fetch(`${endpoint}/auth/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code }),
		});
		if (!res.ok) {
			vscode.window.showErrorMessage(`Sign-in failed: ${await res.text()}`);
			return undefined;
		}
		const session = await res.json() as Session;
		this.session = session;
		await this.context.secrets.store(SECRET_KEY, JSON.stringify(session));
		vscode.window.showInformationMessage(`Signed in as ${session.user}`);
		return session;
	}

	async signOut(): Promise<void> {
		this.session = undefined;
		await this.context.secrets.delete(SECRET_KEY);
	}
}
