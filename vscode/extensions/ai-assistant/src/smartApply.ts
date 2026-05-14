import * as vscode from 'vscode';
import { call } from './anthropic';
import { addMissingImports } from './autoImport';

const SYSTEM = `You merge a code snippet into an existing file. The snippet may be a partial edit (e.g. one function, a few lines) — figure out the right place to insert/replace and produce the full new file content.

Rules:
- Keep all unrelated code untouched.
- Preserve indentation and formatting style of the existing file.
- If the snippet replaces an existing symbol, replace it. If it adds something new, insert at a sensible place.
- Output ONLY the full new file content — no fences, no explanation.`;

export async function smartApply(snippet: string, lang?: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Open a file to apply this snippet to.');
		return;
	}
	const doc = editor.document;
	const original = doc.getText();

	const userMsg = `Target file: ${doc.fileName}\nLanguage: ${lang || doc.languageId}\n\n<existing-file>\n${original}\n</existing-file>\n\n<snippet-to-apply>\n${snippet}\n</snippet-to-apply>`;

	const newText = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI: applying snippet...' },
		async () => {
			const r = await call({
				system: SYSTEM,
				messages: [{ role: 'user', content: userMsg }],
				maxTokens: 4000,
				task: 'cmdK',
			});
			return stripFences(r.text);
		},
	);
	if (!newText || newText === original) {
		vscode.window.showInformationMessage('AI: no changes proposed.');
		return;
	}

	const tmp = await vscode.workspace.openTextDocument({ content: newText, language: doc.languageId });
	await vscode.commands.executeCommand('vscode.diff', doc.uri, tmp.uri, `Smart Apply: ${doc.fileName}`);

	const choice = await vscode.window.showInformationMessage('Apply AI merge to file?', 'Apply', 'Cancel');
	if (choice !== 'Apply') { return; }

	const we = new vscode.WorkspaceEdit();
	const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(original.length));
	we.replace(doc.uri, fullRange, newText);
	await vscode.workspace.applyEdit(we);
	await addMissingImports(doc.uri);
}

function stripFences(s: string): string {
	const m = s.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/);
	return m ? m[1] : s;
}
