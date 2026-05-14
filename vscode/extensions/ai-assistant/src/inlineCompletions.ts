import * as vscode from 'vscode';
import { stream } from './anthropic';

const SYSTEM = `You are an inline code completion engine. Output ONLY the raw code that should be inserted at the cursor — no explanations, no markdown fences. Stop at a natural boundary. Match existing style.`;

export class ClaudeInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private inflight: AbortController | undefined;
	private debounceTimer: NodeJS.Timeout | undefined;

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		if (!cfg.get<boolean>('inlineCompletions.enabled', true)) { return; }

		await new Promise<void>(resolve => {
			if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
			this.debounceTimer = setTimeout(() => resolve(), 200);
		});
		if (token.isCancellationRequested) { return; }

		this.inflight?.abort();
		const ctrl = new AbortController();
		this.inflight = ctrl;
		token.onCancellationRequested(() => ctrl.abort());

		const prefixRange = new vscode.Range(new vscode.Position(0, 0), position);
		const endOfDoc = document.lineAt(document.lineCount - 1).range.end;
		const suffixRange = new vscode.Range(position, endOfDoc);
		const prefix = trimEnd(document.getText(prefixRange), 6000);
		const suffix = trimStart(document.getText(suffixRange), 2000);
		const lang = document.languageId;
		const userMsg = `Language: ${lang}\nFile: ${document.fileName}\n\n<prefix>\n${prefix}\n</prefix>\n\n<suffix>\n${suffix}\n</suffix>`;

		// Stream and collect; stop early on first newline+blank or when we hit max
		const maxTokens = cfg.get<number>('inlineCompletions.maxTokens', 200);
		let collected = '';
		try {
			const it = stream({
				system: SYSTEM,
				messages: [{ role: 'user', content: userMsg }],
				maxTokens,
				task: 'completions',
				signal: ctrl.signal,
			});
			for await (const ev of it) {
				if (token.isCancellationRequested) { return; }
				if (ev.type === 'text_delta' && ev.text) {
					collected += ev.text;
					// Heuristic: stop on a clear boundary to keep latency low
					if (collected.length > 50 && /\n\n/.test(collected)) {
						ctrl.abort();
						break;
					}
				} else if (ev.type === 'message_stop') { break; }
			}
		} catch { /* swallow */ }

		const cleaned = stripFences(collected);
		if (!cleaned.trim()) { return; }
		return [new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position))];
	}
}

function trimEnd(s: string, max: number): string { return s.length > max ? s.slice(s.length - max) : s; }
function trimStart(s: string, max: number): string { return s.length > max ? s.slice(0, max) : s; }
function stripFences(s: string): string {
	const m = s.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/);
	return m ? m[1] : s;
}
