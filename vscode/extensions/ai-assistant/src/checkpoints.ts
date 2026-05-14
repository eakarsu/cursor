import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface Checkpoint {
	id: string;
	label: string;
	createdAt: number;
	files: Map<string, string | null>; // null = file did not exist before
}

export class CheckpointStore {
	private stack: Checkpoint[] = [];
	private maxKeep = 20;
	private outputChannel: vscode.OutputChannel | undefined;

	get all(): Checkpoint[] { return [...this.stack]; }

	async snapshot(label: string, files: string[]): Promise<Checkpoint> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { throw new Error('No workspace folder'); }
		const map = new Map<string, string | null>();
		for (const f of new Set(files)) {
			const abs = path.join(root, f);
			try { map.set(f, await fs.readFile(abs, 'utf8')); }
			catch { map.set(f, null); }
		}
		const cp: Checkpoint = { id: 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), label, createdAt: Date.now(), files: map };
		this.stack.push(cp);
		while (this.stack.length > this.maxKeep) { this.stack.shift(); }
		return cp;
	}

	async rewind(id: string): Promise<number> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { throw new Error('No workspace folder'); }
		const idx = this.stack.findIndex(c => c.id === id);
		if (idx === -1) { throw new Error('Checkpoint not found'); }
		const cp = this.stack[idx];
		let restored = 0;
		for (const [rel, content] of cp.files) {
			const abs = path.join(root, rel);
			if (content === null) {
				try { await fs.unlink(abs); restored++; } catch { /* ignore */ }
			} else {
				await fs.mkdir(path.dirname(abs), { recursive: true });
				await fs.writeFile(abs, content, 'utf8');
				restored++;
			}
		}
		// drop everything from this point forward
		this.stack = this.stack.slice(0, idx);
		this.log(`Rewound to ${cp.label} (${restored} files restored)`);
		return restored;
	}

	private log(msg: string): void {
		if (!this.outputChannel) { this.outputChannel = vscode.window.createOutputChannel('AI Assistant'); }
		this.outputChannel.appendLine(`[checkpoint] ${msg}`);
	}
}

export const checkpoints = new CheckpointStore();
