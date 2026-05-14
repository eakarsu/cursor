import * as vscode from 'vscode';
import * as path from 'path';
import { call } from './anthropic';
import { CodebaseIndex } from './codebaseIndex';

const SYSTEM = `You predict which OTHER files need to change after a recent edit. Look at the just-edited file and the recent change. Identify 1–5 other files that need follow-up edits to keep things consistent (e.g. callers, tests, exports, imports). Return ONLY a JSON array: [{"file":"<rel path>","reason":"<one line>","change":"<the suggested edit>"}]. Empty array if nothing.`;

interface Suggestion { file: string; reason: string; change: string; }

export async function predictMultiFile(index: CodebaseIndex): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return; }
	const rel = path.relative(root, editor.document.uri.fsPath);
	const text = editor.document.getText();
	if (text.length > 80000) {
		vscode.window.showInformationMessage('File too large for cross-file prediction.');
		return;
	}

	await index.ensureBuilt();
	const ctx = await index.formatContext(rel + '\n' + text.slice(0, 4000), 8);
	const userMsg = `Just edited: ${rel}\n\n# File\n\`\`\`\n${text}\n\`\`\`\n\n# Likely-related files (from index)\n${ctx}`;

	const suggestions = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI: predicting cross-file edits...' },
		async () => {
			const r = await call({
				system: SYSTEM,
				messages: [{ role: 'user', content: userMsg }],
				maxTokens: 2000,
				task: 'cmdK',
			});
			return parseArray(r.text);
		},
	);

	if (!suggestions?.length) {
		vscode.window.showInformationMessage('AI: no cross-file follow-ups suggested.');
		return;
	}

	const items = suggestions.map(s => ({
		label: s.file,
		description: s.reason,
		detail: s.change.slice(0, 200),
		s,
	}));
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: `${items.length} suggested follow-ups — pick one to open and apply`,
		matchOnDescription: true,
	});
	if (!pick) { return; }

	const target = vscode.Uri.file(path.join(root, pick.s.file));
	try {
		const doc = await vscode.workspace.openTextDocument(target);
		await vscode.window.showTextDocument(doc);
		await vscode.env.clipboard.writeText(pick.s.change);
		vscode.window.showInformationMessage(`Suggestion copied to clipboard: ${pick.s.reason}`);
	} catch (e: any) {
		vscode.window.showErrorMessage(`Open failed: ${e?.message ?? e}`);
	}
}

function parseArray(text: string): Suggestion[] | undefined {
	const m = text.match(/\[[\s\S]*\]/);
	if (!m) { return; }
	try {
		const arr = JSON.parse(m[0]);
		if (!Array.isArray(arr)) { return; }
		return arr.filter((x: any) => typeof x?.file === 'string' && typeof x?.change === 'string');
	} catch { return; }
}
