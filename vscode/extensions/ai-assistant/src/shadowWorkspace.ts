import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as cp from 'child_process';

// Shadow workspace: copy a subset of the repo into a tmp dir, let the agent edit
// freely there, then run a check command (tests/typecheck) before applying back.

interface Shadow {
	root: string;
	originalRoot: string;
	files: string[];
}

export async function createShadow(files: string[]): Promise<Shadow> {
	const originalRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!originalRoot) { throw new Error('No workspace open.'); }
	const stamp = Date.now().toString(36);
	const root = path.join(os.tmpdir(), `aiAssistant-shadow-${stamp}`);
	await fs.mkdir(root, { recursive: true });
	for (const rel of files) {
		const src = path.join(originalRoot, rel);
		const dst = path.join(root, rel);
		await fs.mkdir(path.dirname(dst), { recursive: true });
		try { await fs.copyFile(src, dst); } catch { /* skip missing */ }
	}
	return { root, originalRoot, files };
}

export async function runCheck(shadow: Shadow, cmd: string): Promise<{ ok: boolean; output: string }> {
	return new Promise(resolve => {
		const c = cp.spawn(cmd, { cwd: shadow.root, shell: true });
		let out = '';
		c.stdout.on('data', d => { out += d.toString(); });
		c.stderr.on('data', d => { out += d.toString(); });
		c.on('close', code => resolve({ ok: code === 0, output: out.slice(-5000) }));
	});
}

export async function applyShadow(shadow: Shadow): Promise<void> {
	for (const rel of shadow.files) {
		const src = path.join(shadow.root, rel);
		const dst = path.join(shadow.originalRoot, rel);
		try {
			const content = await fs.readFile(src);
			await fs.mkdir(path.dirname(dst), { recursive: true });
			await fs.writeFile(dst, content);
		} catch { /* skip */ }
	}
}

export async function discardShadow(shadow: Shadow): Promise<void> {
	try { await fs.rm(shadow.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

export async function shadowApplyCommand(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return; }

	const rel = path.relative(root, editor.document.uri.fsPath);
	const shadow = await createShadow([rel]);

	const checkCmd = await vscode.window.showInputBox({
		prompt: 'Check command (run inside shadow before applying)',
		placeHolder: 'tsc --noEmit  /  npm test  /  python -m pytest',
		value: 'tsc --noEmit',
	});
	if (!checkCmd) { await discardShadow(shadow); return; }

	const { ok, output } = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI: running check in shadow...' },
		() => runCheck(shadow, checkCmd),
	);

	const doc = await vscode.workspace.openTextDocument({
		content: `Check ${ok ? 'PASSED' : 'FAILED'}\n\n${output}`,
		language: 'log',
	});
	await vscode.window.showTextDocument(doc, { preview: true });

	if (ok) {
		const apply = await vscode.window.showInformationMessage('Check passed. Apply shadow to real workspace?', 'Apply', 'Discard');
		if (apply === 'Apply') { await applyShadow(shadow); }
	}
	await discardShadow(shadow);
}
