import * as vscode from 'vscode';
import * as os from 'os';
import { call } from './anthropic';

const SYSTEM = `You generate ONE shell command from a natural-language request. Output ONLY the command — no fences, no explanation, no leading $. The command must be safe to paste into a terminal. If the request is ambiguous, pick the most common interpretation.`;

export async function terminalCmdK(): Promise<void> {
	const term = vscode.window.activeTerminal;
	if (!term) {
		vscode.window.showInformationMessage('Open a terminal first.');
		return;
	}

	const instruction = await vscode.window.showInputBox({
		prompt: 'AI: terminal command',
		placeHolder: 'find all .ts files larger than 1MB',
	});
	if (!instruction) { return; }

	const ctx = `OS: ${os.platform()} ${os.release()}\nShell: ${vscode.env.shell || process.env.SHELL || 'bash'}\nCWD: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()}`;

	const cmd = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'AI: generating command...' },
		async () => {
			const r = await call({
				system: SYSTEM,
				messages: [{ role: 'user', content: `${ctx}\n\nRequest: ${instruction}` }],
				maxTokens: 200,
				task: 'cmdK',
			});
			return r.text.trim().replace(/^\$\s*/, '').replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
		}
	);
	if (!cmd) { return; }

	const choice = await vscode.window.showInformationMessage(
		`Run: ${cmd}`, { modal: false }, 'Run', 'Paste only', 'Cancel'
	);
	if (choice === 'Run') {
		term.show();
		term.sendText(cmd, true);
	} else if (choice === 'Paste only') {
		term.show();
		term.sendText(cmd, false);
	}
}
