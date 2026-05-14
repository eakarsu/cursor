import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Auth } from './auth';

export class CloudSync {
	constructor(private auth: Auth) { }

	private endpoint(): string | undefined {
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		if (cfg.get<boolean>('privacyMode', false)) { return undefined; }
		return cfg.get<string>('cloudEndpoint');
	}

	private async authHeader(): Promise<Record<string, string>> {
		const s = this.auth.current();
		return s ? { authorization: `Bearer ${s.token}` } : {};
	}

	async pushMemory(): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const ep = this.endpoint();
		if (!root || !ep || !this.auth.current()) { return; }
		const files = ['.aicode/memory.md', '.aicode/rules.md'];
		const payload: Record<string, string> = {};
		for (const f of files) {
			try { payload[f] = await fs.readFile(path.join(root, f), 'utf8'); } catch { /* skip */ }
		}
		if (!Object.keys(payload).length) { return; }
		await fetch(`${ep}/sync/memory`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...await this.authHeader() },
			body: JSON.stringify({ workspace: vscode.workspace.workspaceFolders?.[0]?.name, files: payload }),
		}).catch(() => undefined);
	}

	async pullMemory(): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const ep = this.endpoint();
		if (!root || !ep || !this.auth.current()) { return; }
		const res = await fetch(`${ep}/sync/memory?workspace=${encodeURIComponent(vscode.workspace.workspaceFolders![0].name)}`, {
			headers: { ...await this.authHeader() },
		}).catch(() => undefined);
		if (!res || !res.ok) { return; }
		const json = await res.json() as { files: Record<string, string> };
		for (const [rel, content] of Object.entries(json.files ?? {})) {
			const abs = path.join(root, rel);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, content, 'utf8');
		}
	}
}
