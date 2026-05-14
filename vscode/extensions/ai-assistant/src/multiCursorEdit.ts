import * as vscode from 'vscode';
import { call } from './anthropic';

const SYSTEM = `You apply the same edit to multiple code locations. For each occurrence, return the replacement text. Output ONLY a JSON array of strings, one per occurrence in order. No prose, no fences.`;

export async function multiCursorEdit(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }

	const sel = editor.document.getText(editor.selection);
	const needle = sel.trim() || await vscode.window.showInputBox({ prompt: 'Find pattern (substring or /regex/)' });
	if (!needle) { return; }

	const instruction = await vscode.window.showInputBox({
		prompt: 'Edit instruction',
		placeHolder: 'rename to camelCase / add null check / convert to async',
	});
	if (!instruction) { return; }

	const text = editor.document.getText();
	const ranges = findOccurrences(text, needle, editor.document);
	if (!ranges.length) {
		vscode.window.showInformationMessage(`No occurrences of "${needle}".`);
		return;
	}

	const snippets = ranges.map((r, i) => {
		const line = editor.document.lineAt(r.start.line).text;
		return `[${i}] L${r.start.line + 1}: ${line.trim()}`;
	}).join('\n');

	const userMsg = `Instruction: ${instruction}\n\nLanguage: ${editor.document.languageId}\nMatch: "${needle}"\n\nOccurrences:\n${snippets}\n\nReturn the replacement text for each [i], in order, as a JSON array. The replacement replaces the entire matched substring, NOT the line.`;

	const replacements = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `AI: editing ${ranges.length} occurrences...` },
		async () => {
			const r = await call({
				system: SYSTEM,
				messages: [{ role: 'user', content: userMsg }],
				maxTokens: 2000,
				task: 'cmdK',
			});
			return parseArray(r.text);
		}
	);

	if (!replacements || replacements.length !== ranges.length) {
		vscode.window.showErrorMessage(`Expected ${ranges.length} replacements, got ${replacements?.length ?? 0}.`);
		return;
	}

	const we = new vscode.WorkspaceEdit();
	for (let i = 0; i < ranges.length; i++) {
		we.replace(editor.document.uri, ranges[i], replacements[i]);
	}
	await vscode.workspace.applyEdit(we);
	vscode.window.showInformationMessage(`Applied ${ranges.length} edits.`);
}

function findOccurrences(text: string, needle: string, doc: vscode.TextDocument): vscode.Range[] {
	const ranges: vscode.Range[] = [];
	let regex: RegExp;
	const m = needle.match(/^\/(.+)\/([gimsuy]*)$/);
	if (m) {
		try { regex = new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g'); } catch { return []; }
	} else {
		regex = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
	}
	let mr: RegExpExecArray | null;
	while ((mr = regex.exec(text))) {
		const start = doc.positionAt(mr.index);
		const end = doc.positionAt(mr.index + mr[0].length);
		ranges.push(new vscode.Range(start, end));
		if (mr[0].length === 0) { regex.lastIndex++; }
	}
	return ranges;
}

function parseArray(text: string): string[] | undefined {
	const m = text.match(/\[[\s\S]*\]/);
	if (!m) { return; }
	try {
		const arr = JSON.parse(m[0]);
		if (!Array.isArray(arr) || arr.some(x => typeof x !== 'string')) { return; }
		return arr;
	} catch { return; }
}
