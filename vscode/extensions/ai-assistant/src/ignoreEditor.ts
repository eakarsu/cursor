import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

const TEMPLATE = `# AI Assistant indexing exclusions
# One glob pattern per line. Lines starting with # are comments.
# Patterns match relative paths inside the workspace.
# Examples:
#   secrets/**
#   *.log
#   build/**
#   **/*.min.js
#   data/**
#   docs/private/**

# Add your exclusions below:
`;

export async function editIgnore(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showWarningMessage('Open a workspace first.');
		return;
	}
	const file = path.join(root, '.aicodeignore');
	try {
		await fs.access(file);
	} catch {
		await fs.writeFile(file, TEMPLATE, 'utf8');
	}
	const doc = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(doc);
	vscode.window.showInformationMessage('Save the file and run "AI: Reindex Workspace" to apply.', 'Reindex now')
		.then(choice => { if (choice === 'Reindex now') { void vscode.commands.executeCommand('aiAssistant.indexWorkspace'); } });
}
