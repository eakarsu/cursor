import * as vscode from 'vscode';
import * as cp from 'child_process';
import { call } from './anthropic';

const SYSTEM = `You are a senior code reviewer. Audit the diff for: bugs, security issues, perf regressions, missing tests, unclear code. Be specific and brief — quote the line, give one sentence of feedback. Skip nits and praise. Return markdown with sections "## Critical", "## Suggestions", "## Tests". If clean, say so.`;

export async function reviewPr(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return; }

	const base = await vscode.window.showInputBox({
		prompt: 'Base branch (or commit ref)',
		value: 'main',
	});
	if (!base) { return; }

	const diff = await runGit(['diff', `${base}...HEAD`], root);
	if (!diff || !diff.trim()) {
		vscode.window.showInformationMessage('No changes vs base.');
		return;
	}
	if (diff.length > 200000) {
		vscode.window.showWarningMessage('Diff too large; reviewing first 200KB.');
	}

	const review = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI: reviewing PR...' },
		async () => {
			const r = await call({
				system: SYSTEM,
				messages: [{ role: 'user', content: `Diff vs ${base}:\n\n\`\`\`diff\n${diff.slice(0, 200000)}\n\`\`\`` }],
				maxTokens: 4000,
				task: 'chat',
			});
			return r.text;
		}
	);

	const doc = await vscode.workspace.openTextDocument({ content: review, language: 'markdown' });
	await vscode.window.showTextDocument(doc, { preview: true });

	const post = await vscode.window.showInformationMessage(
		'Post review as a comment on the current PR via gh?', 'Post', 'Skip'
	);
	if (post === 'Post') {
		try {
			await runGit(['pr', 'comment', '--body', review], root, 'gh');
			vscode.window.showInformationMessage('Posted PR comment.');
		} catch (e: any) {
			vscode.window.showErrorMessage(`gh failed: ${e?.message ?? e}`);
		}
	}
}

function runGit(args: string[], cwd: string, bin = 'git'): Promise<string> {
	return new Promise((resolve, reject) => {
		const c = cp.spawn(bin, args, { cwd });
		let out = '', err = '';
		c.stdout.on('data', d => { out += d.toString(); });
		c.stderr.on('data', d => { err += d.toString(); });
		c.on('error', reject);
		c.on('close', code => {
			if (code !== 0) { reject(new Error(err || `${bin} exit ${code}`)); }
			else { resolve(out); }
		});
	});
}
