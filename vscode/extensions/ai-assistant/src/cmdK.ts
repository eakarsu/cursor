import * as vscode from 'vscode';
import { stream } from './anthropic';
import { loadRulesAndMemory } from './rules';
import { addMissingImports } from './autoImport';

const SYSTEM = `You modify code per the user's instruction. Output ONLY the replacement text — no fences, no explanation. Preserve indentation. If the user asks for a new addition rather than a modification, return only the inserted text.`;

interface PendingEdit {
	editor: vscode.TextEditor;
	addRange: vscode.Range;
	delRange: vscode.Range;
	originalText: string;
	replacementText: string;
	addDeco: vscode.TextEditorDecorationType;
	delDeco: vscode.TextEditorDecorationType;
	codeLensProvider: vscode.Disposable;
}

let pending: PendingEdit | undefined;

export async function cmdK(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }

	let range: vscode.Range = editor.selection;
	if (range.isEmpty) {
		range = editor.document.lineAt(editor.selection.active.line).range;
	}
	const original = editor.document.getText(range);

	const instruction = await vscode.window.showInputBox({
		prompt: 'AI: edit instruction',
		placeHolder: range.isEmpty ? 'add a null check' : 'convert to async/await',
	});
	if (!instruction) { return; }

	const rules = await loadRulesAndMemory();
	const lang = editor.document.languageId;
	const fileText = editor.document.getText();
	const startOff = editor.document.offsetAt(range.start);
	const endOff = editor.document.offsetAt(range.end);
	const before = fileText.slice(Math.max(0, startOff - 2000), startOff);
	const after = fileText.slice(endOff, endOff + 2000);

	const userMsg = `Language: ${lang}\nFile: ${editor.document.fileName}\n\nInstruction: ${instruction}\n\n<context-before>\n${before}\n</context-before>\n\n<selection>\n${original}\n</selection>\n\n<context-after>\n${after}\n</context-after>`;

	if (pending) { await dismissPending(false); }

	// Insert a single newline at the start of the range so we have a blank line
	// to stream into. Decorations + accept/reject set up after streaming.
	const insertEdit = new vscode.WorkspaceEdit();
	insertEdit.insert(editor.document.uri, range.start, '\n');
	await vscode.workspace.applyEdit(insertEdit);

	const streamLineDeco = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(60, 200, 90, 0.12)',
		isWholeLine: true,
		borderWidth: '0 0 0 3px',
		borderStyle: 'solid',
		borderColor: 'rgba(60, 200, 90, 0.8)',
	});
	const streamStart = range.start;
	let streamedLen = 0;
	const updateStreamDeco = (): void => {
		const endPos = editor.document.positionAt(editor.document.offsetAt(streamStart) + streamedLen);
		editor.setDecorations(streamLineDeco, [new vscode.Range(streamStart, endPos)]);
	};
	updateStreamDeco();

	const status = vscode.window.setStatusBarMessage('$(sparkle) AI: streaming edit...');
	let buffered = '';
	let aborted = false;

	try {
		const gen = stream({
			system: [SYSTEM, rules].filter(Boolean).join('\n\n'),
			messages: [{ role: 'user', content: userMsg }],
			maxTokens: 1500,
			task: 'cmdK',
		});
		for (;;) {
			const next = await gen.next();
			if (next.done) { break; }
			const ev = next.value;
			if (ev.type === 'text_delta' && ev.text) {
				buffered += ev.text;
				const insertPos = editor.document.positionAt(editor.document.offsetAt(streamStart) + streamedLen);
				const ok = await editor.edit(eb => { eb.insert(insertPos, ev.text!); }, { undoStopBefore: false, undoStopAfter: false });
				if (ok) {
					streamedLen += ev.text.length;
					updateStreamDeco();
				}
			} else if (ev.type === 'error') {
				throw new Error(ev.error ?? 'stream error');
			}
		}
	} catch (e: any) {
		aborted = true;
		// Roll back the streamed insert and the leading newline
		const rollbackEnd = editor.document.positionAt(editor.document.offsetAt(streamStart) + streamedLen + 1);
		const undo = new vscode.WorkspaceEdit();
		undo.delete(editor.document.uri, new vscode.Range(streamStart, rollbackEnd));
		await vscode.workspace.applyEdit(undo);
		streamLineDeco.dispose();
		status.dispose();
		vscode.window.showErrorMessage(`AI: ${e?.message ?? e}`);
		return;
	}

	streamLineDeco.dispose();
	status.dispose();
	if (aborted) { return; }

	const replacement = stripFences(buffered);
	if (!replacement.trim()) { return; }

	// Remove the streamed text (and its leading newline) so applyAndShowDiff
	// can reinsert with proper add/del decorations and code-lens.
	const streamedEnd = editor.document.positionAt(editor.document.offsetAt(streamStart) + streamedLen + 1);
	const cleanup = new vscode.WorkspaceEdit();
	cleanup.delete(editor.document.uri, new vscode.Range(streamStart, streamedEnd));
	await vscode.workspace.applyEdit(cleanup);

	await applyAndShowDiff(editor, range, original, replacement);
}

async function applyAndShowDiff(editor: vscode.TextEditor, range: vscode.Range, original: string, replacement: string): Promise<void> {
	if (pending) { await dismissPending(false); }

	// Insert replacement BEFORE the original (with newline). Both stay visible:
	// new text gets green decoration, old text gets red strikethrough.
	const needsNewline = !replacement.endsWith('\n');
	const insertion = replacement + (needsNewline ? '\n' : '');

	const we = new vscode.WorkspaceEdit();
	we.insert(editor.document.uri, range.start, insertion);
	await vscode.workspace.applyEdit(we);

	const startOff = editor.document.offsetAt(range.start);
	const addEnd = editor.document.positionAt(startOff + insertion.length);
	const addRange = new vscode.Range(range.start, addEnd);
	const delEnd = editor.document.positionAt(startOff + insertion.length + original.length);
	const delRange = new vscode.Range(addEnd, delEnd);

	const addDeco = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(60, 200, 90, 0.16)',
		isWholeLine: true,
		overviewRulerColor: 'rgba(60, 200, 90, 0.7)',
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		borderWidth: '0 0 0 3px',
		borderStyle: 'solid',
		borderColor: 'rgba(60, 200, 90, 0.8)',
	});
	const delDeco = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(229, 57, 53, 0.16)',
		isWholeLine: true,
		overviewRulerColor: 'rgba(229, 57, 53, 0.7)',
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		borderWidth: '0 0 0 3px',
		borderStyle: 'solid',
		borderColor: 'rgba(229, 57, 53, 0.8)',
		textDecoration: 'line-through; opacity: 0.55',
	});
	editor.setDecorations(addDeco, [addRange]);
	editor.setDecorations(delDeco, [delRange]);

	const lensProvider: vscode.CodeLensProvider = {
		provideCodeLenses(doc) {
			if (!pending || pending.editor.document !== doc) { return []; }
			const r = new vscode.Range(pending.addRange.start, pending.addRange.start);
			return [
				new vscode.CodeLens(r, { command: 'aiAssistant.acceptCmdK', title: '✓ Accept' }),
				new vscode.CodeLens(r, { command: 'aiAssistant.rejectCmdK', title: '✗ Reject' }),
			];
		},
	};
	const codeLensProvider = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider);

	pending = { editor, addRange, delRange, originalText: original, replacementText: insertion, addDeco, delDeco, codeLensProvider };
	await vscode.commands.executeCommand('setContext', 'aiAssistant.cmdK.pending', true);
}

export async function acceptPending(): Promise<void> {
	if (!pending) { return; }
	const { editor, delRange } = pending;
	const we = new vscode.WorkspaceEdit();
	we.delete(editor.document.uri, delRange);
	await vscode.workspace.applyEdit(we);
	await addMissingImports(editor.document.uri);
	await dismissPending(true);
}

export async function rejectPending(): Promise<void> {
	if (!pending) { return; }
	const { editor, addRange } = pending;
	const we = new vscode.WorkspaceEdit();
	we.delete(editor.document.uri, addRange);
	await vscode.workspace.applyEdit(we);
	await dismissPending(false);
}

async function dismissPending(_accepted: boolean): Promise<void> {
	if (!pending) { return; }
	pending.addDeco.dispose();
	pending.delDeco.dispose();
	pending.codeLensProvider.dispose();
	pending = undefined;
	await vscode.commands.executeCommand('setContext', 'aiAssistant.cmdK.pending', false);
}

function stripFences(s: string): string {
	const m = s.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/);
	return m ? m[1] : s;
}
