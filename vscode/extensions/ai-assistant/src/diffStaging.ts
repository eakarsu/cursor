import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Checkpoint } from './checkpoints';

export interface FileDiff {
	relPath: string;
	before: string | null;
	after: string | null;
}

export async function buildFileDiffs(cp: Checkpoint): Promise<FileDiff[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return []; }
	const out: FileDiff[] = [];
	for (const [rel, before] of cp.files) {
		const abs = path.join(root, rel);
		let after: string | null = null;
		try { after = await fs.readFile(abs, 'utf8'); } catch { after = null; }
		if (before === after) { continue; }
		out.push({ relPath: rel, before, after });
	}
	return out;
}

export async function showDiffStaging(diffs: FileDiff[], onFinish: () => void): Promise<void> {
	if (!diffs.length) {
		vscode.window.showInformationMessage('AI: no changes.');
		onFinish();
		return;
	}
	const items: Array<vscode.QuickPickItem & { diff: FileDiff }> = diffs.map(d => ({
		label: `${changeKind(d)} ${d.relPath}`,
		picked: true,
		diff: d,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		title: 'Review AI changes',
		placeHolder: 'Uncheck files to revert; press Enter to keep selected, Esc to revert all.',
	});
	if (!picked) {
		// User cancelled — revert all
		await revertAll(diffs);
	} else {
		const keep = new Set(picked.map(p => p.diff.relPath));
		const revert = diffs.filter(d => !keep.has(d.relPath));
		await revertAll(revert);
	}
	onFinish();
}

function changeKind(d: FileDiff): string {
	if (d.before === null) { return '[new]'; }
	if (d.after === null) { return '[del]'; }
	return '[edit]';
}

async function revertAll(diffs: FileDiff[]): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return; }
	for (const d of diffs) {
		const abs = path.join(root, d.relPath);
		if (d.before === null) {
			try { await fs.unlink(abs); } catch { /* ignore */ }
		} else {
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, d.before, 'utf8');
		}
	}
}

export async function showInlineDiff(relPath: string, before: string, after: string): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return; }
	const leftUri = vscode.Uri.parse(`ai-diff:${relPath}.before?${encodeURIComponent(before)}`);
	const rightUri = vscode.Uri.parse(`ai-diff:${relPath}.after?${encodeURIComponent(after)}`);
	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${relPath} (AI changes)`);
}
