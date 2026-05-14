import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

function notepadDir(): string | undefined {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return root ? path.join(root, '.aicode', 'notepads') : undefined;
}

export async function readNotepad(name: string): Promise<string | undefined> {
	const dir = notepadDir();
	if (!dir) { return; }
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
	try { return await fs.readFile(path.join(dir, `${safe}.md`), 'utf8'); } catch { return; }
}

export async function listNotepads(): Promise<string[]> {
	const dir = notepadDir();
	if (!dir) { return []; }
	try {
		const entries = await fs.readdir(dir);
		return entries.filter(e => e.endsWith('.md')).map(e => e.slice(0, -3));
	} catch { return []; }
}

export function registerNotepads(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.editNotepads', editNotepads),
	);
}

async function editNotepads(): Promise<void> {
	const dir = notepadDir();
	if (!dir) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}
	await fs.mkdir(dir, { recursive: true });

	const existing = await listNotepads();
	const items: vscode.QuickPickItem[] = [
		{ label: '$(add) New notepad...', description: 'create' },
		...existing.map(n => ({ label: n, description: 'open' })),
	];
	const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a notepad' });
	if (!pick) { return; }

	let name: string;
	if (pick.description === 'create') {
		const input = await vscode.window.showInputBox({ prompt: 'Notepad name', placeHolder: 'review-checklist' });
		if (!input) { return; }
		name = input.replace(/[^a-zA-Z0-9._-]/g, '_');
	} else {
		name = pick.label;
	}

	const file = path.join(dir, `${name}.md`);
	try { await fs.access(file); } catch {
		await fs.writeFile(file, `# ${name}\n\nWrite your reusable prompt here. Reference with @notepad:${name}\n`, 'utf8');
	}
	const doc = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(doc);
}
