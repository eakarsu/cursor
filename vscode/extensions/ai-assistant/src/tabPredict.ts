import * as vscode from 'vscode';
import { stream } from './anthropic';

// Edit history: keep the last few text changes so the model has signal about what just happened.
interface EditEntry { uri: string; range: vscode.Range; replacedText: string; insertedText: string; ts: number; }
const editHistory: EditEntry[] = [];
const MAX_HISTORY = 8;

const SYSTEM = `Predict the user's NEXT edit. They just made a change. Use the edit history to anticipate the next 1-10 lines they'll add or modify. Return ONLY a JSON object on a single line:
{"line":<0-based>,"column":<0-based>,"insert":"<text>","replace_lines":<int>}
If unclear, return {"insert":""}.`;

interface Prediction { line: number; column: number; insert: string; replace_lines?: number; }

let pendingDecoType: vscode.TextEditorDecorationType | undefined;
let pending: { editor: vscode.TextEditor; pred: Prediction } | undefined;
let timer: NodeJS.Timeout | undefined;

const VISIBLE_CTX = 'aiAssistant.tabPrediction.visible';

export function registerTabPrediction(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(e => {
			const cfg = vscode.workspace.getConfiguration('aiAssistant');
			if (!cfg.get<boolean>('tabPrediction.enabled', true)) { return; }
			if (e.document.uri.scheme !== 'file') { return; }
			for (const ch of e.contentChanges) {
				editHistory.push({
					uri: e.document.uri.toString(),
					range: ch.range,
					replacedText: ch.rangeLength ? e.document.getText(ch.range) : '',
					insertedText: ch.text,
					ts: Date.now(),
				});
			}
			while (editHistory.length > MAX_HISTORY) { editHistory.shift(); }
			if (timer) { clearTimeout(timer); }
			timer = setTimeout(() => maybePredict(e.document), 600);
		}),
		vscode.window.onDidChangeTextEditorSelection(() => clearPending()),
	);
}

async function maybePredict(doc: vscode.TextDocument): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document !== doc) { return; }
	const text = doc.getText();
	if (text.length > 200000) { return; }
	const pos = editor.selection.active;
	const recent = editHistory.slice(-5).map(h => `replaced "${h.replacedText.slice(0, 80)}" -> "${h.insertedText.slice(0, 80)}"`).join('\n');
	const userMsg = `Cursor at L${pos.line}:C${pos.character}.\n\n# Recent edits\n${recent}\n\n# File\n<file>\n${text}\n</file>`;

	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const endpoint = cfg.get<string>('tabModelEndpoint', '').trim();

	let collected = '';
	try {
		if (endpoint) {
			collected = await callOpenAICompatible(endpoint, SYSTEM, userMsg);
		} else {
			const it = stream({
				system: SYSTEM,
				messages: [{ role: 'user', content: userMsg }],
				maxTokens: 300,
				task: 'completions',
			});
			for await (const ev of it) {
				if (ev.type === 'text_delta' && ev.text) {
					collected += ev.text;
					if (collected.includes('}')) { break; }
				} else if (ev.type === 'message_stop') { break; }
			}
		}
	} catch { return; }

	const json = extractJson(collected);
	if (!json || !json.insert?.trim()) { return; }
	showPrediction(editor, json);
}

async function callOpenAICompatible(endpoint: string, system: string, user: string): Promise<string> {
	const url = endpoint.replace(/\/$/, '') + '/chat/completions';
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 8000);
	try {
		const res = await fetch(url, {
			method: 'POST',
			signal: ctrl.signal,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'tab',
				messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
				max_tokens: 300,
				temperature: 0.2,
				stream: false,
			}),
		});
		if (!res.ok) { return ''; }
		const j: any = await res.json();
		return j?.choices?.[0]?.message?.content ?? '';
	} finally { clearTimeout(timer); }
}

function extractJson(s: string): Prediction | undefined {
	const m = s.match(/\{[\s\S]*?\}/);
	if (!m) { return; }
	try { return JSON.parse(m[0]); } catch { return; }
}

function showPrediction(editor: vscode.TextEditor, pred: Prediction): void {
	clearPending();
	const lineCount = editor.document.lineCount;
	const line = Math.min(Math.max(0, pred.line ?? editor.selection.active.line), lineCount - 1);
	const col = Math.max(0, pred.column ?? 0);
	const pos = new vscode.Position(line, col);
	const lines = pred.insert.split('\n');
	pendingDecoType = vscode.window.createTextEditorDecorationType({
		after: {
			contentText: ' ⏎ ' + (lines[0]?.slice(0, 80) ?? '') + (lines.length > 1 ? ` (+${lines.length - 1})` : ''),
			color: 'rgba(150, 150, 150, 0.7)',
			fontStyle: 'italic',
		},
	});
	editor.setDecorations(pendingDecoType, [new vscode.Range(pos, pos)]);
	pending = { editor, pred: { ...pred, line, column: col } };
	void vscode.commands.executeCommand('setContext', VISIBLE_CTX, true);
}

export async function acceptTabPrediction(): Promise<boolean> {
	if (!pending) { return false; }
	const { editor, pred } = pending;
	clearPending();
	const start = new vscode.Position(pred.line, pred.column);
	const replaceLines = pred.replace_lines ?? 0;
	const endLine = Math.min(editor.document.lineCount - 1, pred.line + replaceLines);
	const end = replaceLines === 0 ? start : editor.document.lineAt(endLine).range.end;
	await editor.edit(b => {
		if (replaceLines === 0) { b.insert(start, pred.insert); } else { b.replace(new vscode.Range(start, end), pred.insert); }
	});
	return true;
}

function clearPending(): void {
	if (pendingDecoType) { pendingDecoType.dispose(); pendingDecoType = undefined; }
	pending = undefined;
	void vscode.commands.executeCommand('setContext', VISIBLE_CTX, false);
}
