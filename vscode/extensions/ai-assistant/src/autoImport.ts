import * as vscode from 'vscode';

// After applying AI-generated code, ask VS Code's LSPs to add missing imports.
// Uses the universal "source.addMissingImports" code action — works for TS, JS,
// Python (Pylance), Java, etc., when the language server supports it.
export async function addMissingImports(uri: vscode.Uri): Promise<void> {
	try {
		const doc = await vscode.workspace.openTextDocument(uri);
		const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);

		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider',
			uri, fullRange,
			'source.addMissingImports',
		);
		if (!actions?.length) {
			// Fall back to organize imports.
			await vscode.commands.executeCommand('editor.action.organizeImports').then(undefined, () => undefined);
			return;
		}
		for (const a of actions) {
			if (a.edit) { await vscode.workspace.applyEdit(a.edit); }
			if (a.command) {
				await vscode.commands.executeCommand(a.command.command, ...(a.command.arguments ?? []));
			}
		}
	} catch { /* best-effort */ }
}
