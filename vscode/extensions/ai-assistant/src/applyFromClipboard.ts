import * as vscode from 'vscode';
import { call } from './anthropic';

const SYSTEM = `You apply a code snippet (likely from an external chat like claude.ai or chatgpt.com) into the user's existing file. The user already has the file open. Decide where the snippet goes — it may replace a region, add a new function, or extend a class. Output ONLY the FULL final file contents. No fences, no commentary.`;

export async function applyFromClipboard(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage('Open a file first.');
		return;
	}
	const clip = (await vscode.env.clipboard.readText()).trim();
	if (!clip) {
		vscode.window.showInformationMessage('Clipboard is empty.');
		return;
	}

	const snippet = stripFences(clip);
	const original = editor.document.getText();
	const lang = editor.document.languageId;

	const userMsg = `Language: ${lang}\nFile: ${editor.document.fileName}\n\n# Existing file\n\`\`\`${lang}\n${original}\n\`\`\`\n\n# Snippet to apply (from clipboard)\n\`\`\`\n${snippet}\n\`\`\`\n\nReturn the full updated file.`;

	const updated = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI: applying clipboard...' },
		async () => {
			const r = await call({
				system: SYSTEM,
				messages: [{ role: 'user', content: userMsg }],
				maxTokens: 8000,
				task: 'cmdK',
			});
			return stripFences(r.text);
		}
	);
	if (!updated || updated === original) {
		vscode.window.showInformationMessage('No changes produced.');
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'AI: apply clipboard snippet to this file?', { modal: false }, 'Apply', 'Show diff', 'Cancel'
	);
	if (choice === 'Cancel' || !choice) { return; }

	if (choice === 'Show diff') {
		const left = vscode.Uri.parse(`untitled:${editor.document.fileName}.original`);
		const leftDoc = await vscode.workspace.openTextDocument({ content: original, language: lang });
		const rightDoc = await vscode.workspace.openTextDocument({ content: updated, language: lang });
		await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, 'AI: clipboard apply');
		void left;
		return;
	}

	const fullRange = new vscode.Range(
		editor.document.positionAt(0),
		editor.document.positionAt(original.length),
	);
	await editor.edit(b => b.replace(fullRange, updated));
}

function stripFences(s: string): string {
	const m = s.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/);
	return m ? m[1] : s;
}
