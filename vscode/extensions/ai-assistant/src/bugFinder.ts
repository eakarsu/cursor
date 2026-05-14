import * as vscode from 'vscode';
import { call } from './anthropic';
import { loadRulesAndMemory } from './rules';

const SYSTEM = `You audit code for bugs. Return ONLY a JSON array of {"line":<1-based>,"severity":"error"|"warning"|"info","message":"<short>","suggestion":"<optional fix>"}. Be conservative — only flag real issues. Empty array if clean.`;

interface Finding { line: number; severity: 'error' | 'warning' | 'info'; message: string; suggestion?: string; }

let diag: vscode.DiagnosticCollection | undefined;

export function registerBugFinder(context: vscode.ExtensionContext): void {
	diag = vscode.languages.createDiagnosticCollection('aiAssistant');
	context.subscriptions.push(diag);
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.findBugs', findBugsInActive),
		vscode.commands.registerCommand('aiAssistant.clearBugs', () => diag?.clear()),
	);
}

async function findBugsInActive(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !diag) { return; }
	const doc = editor.document;
	const text = doc.getText();
	if (text.length > 80000) {
		vscode.window.showWarningMessage('AI: file too large for bug finder.');
		return;
	}

	const rules = await loadRulesAndMemory();
	const userMsg = `Language: ${doc.languageId}\nFile: ${doc.fileName}\n\n<code>\n${text}\n</code>`;

	const findings = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI: scanning for bugs...' },
		async () => {
			try {
				const r = await call({
					system: [SYSTEM, rules].filter(Boolean).join('\n\n'),
					messages: [{ role: 'user', content: userMsg }],
					maxTokens: 2000,
					task: 'cmdK',
				});
				return parseFindings(r.text);
			} catch (e: any) {
				vscode.window.showErrorMessage(`Bug finder failed: ${e?.message ?? e}`);
				return [];
			}
		}
	);

	const items: vscode.Diagnostic[] = findings.map(f => {
		const line = Math.min(Math.max(0, f.line - 1), doc.lineCount - 1);
		const range = doc.lineAt(line).range;
		const sev = f.severity === 'error' ? vscode.DiagnosticSeverity.Error
			: f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
			: vscode.DiagnosticSeverity.Information;
		const msg = f.suggestion ? `${f.message}\n→ ${f.suggestion}` : f.message;
		const d = new vscode.Diagnostic(range, msg, sev);
		d.source = 'AI';
		return d;
	});
	diag.set(doc.uri, items);

	if (!items.length) {
		vscode.window.showInformationMessage('AI: no issues found.');
	} else {
		vscode.window.showInformationMessage(`AI: ${items.length} issue${items.length === 1 ? '' : 's'} found. See Problems panel.`);
	}
}

function parseFindings(text: string): Finding[] {
	const m = text.match(/\[[\s\S]*\]/);
	if (!m) { return []; }
	try {
		const arr = JSON.parse(m[0]);
		if (!Array.isArray(arr)) { return []; }
		return arr.filter((x: any) => typeof x?.line === 'number' && typeof x?.message === 'string');
	} catch { return []; }
}
