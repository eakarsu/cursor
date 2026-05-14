import * as vscode from 'vscode';

export interface LspContext {
	symbols: Array<{ name: string; kind: string; line: number }>;
	definitions: Array<{ symbol: string; uri: string; range: string; preview: string }>;
	references: Array<{ symbol: string; locations: number }>;
	diagnostics: Array<{ severity: string; message: string; line: number }>;
}

export async function gatherForDocument(doc: vscode.TextDocument, position?: vscode.Position): Promise<LspContext> {
	const out: LspContext = { symbols: [], definitions: [], references: [], diagnostics: [] };

	// Document symbols
	try {
		const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
			'vscode.executeDocumentSymbolProvider', doc.uri
		);
		flattenSymbols(syms ?? [], out.symbols);
	} catch { /* skip */ }

	// Diagnostics
	for (const d of vscode.languages.getDiagnostics(doc.uri)) {
		out.diagnostics.push({
			severity: vscode.DiagnosticSeverity[d.severity],
			message: d.message.slice(0, 200),
			line: d.range.start.line,
		});
	}

	// If a position is given, pull definitions + references for the symbol at the cursor
	if (position) {
		try {
			const defs = await vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeDefinitionProvider', doc.uri, position
			);
			for (const def of (defs ?? []).slice(0, 5)) {
				try {
					const targetDoc = await vscode.workspace.openTextDocument(def.uri);
					const text = targetDoc.getText(def.range);
					out.definitions.push({
						symbol: doc.getText(doc.getWordRangeAtPosition(position) ?? new vscode.Range(position, position)),
						uri: vscode.workspace.asRelativePath(def.uri),
						range: `${def.range.start.line + 1}-${def.range.end.line + 1}`,
						preview: text.slice(0, 400),
					});
				} catch { /* skip */ }
			}
		} catch { /* skip */ }

		try {
			const refs = await vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeReferenceProvider', doc.uri, position
			);
			out.references.push({
				symbol: doc.getText(doc.getWordRangeAtPosition(position) ?? new vscode.Range(position, position)),
				locations: refs?.length ?? 0,
			});
		} catch { /* skip */ }
	}

	return out;
}

function flattenSymbols(syms: any[], out: Array<{ name: string; kind: string; line: number }>): void {
	for (const s of syms) {
		const range = s.range ?? s.location?.range;
		if (range) {
			out.push({
				name: s.name,
				kind: vscode.SymbolKind[s.kind],
				line: range.start.line,
			});
		}
		if (s.children) { flattenSymbols(s.children, out); }
	}
}

export function formatLspContext(ctx: LspContext): string {
	const parts: string[] = [];
	if (ctx.symbols.length) {
		parts.push('## Symbols\n' + ctx.symbols.slice(0, 30).map(s => `- ${s.kind} ${s.name} @${s.line + 1}`).join('\n'));
	}
	if (ctx.definitions.length) {
		parts.push('## Definitions\n' + ctx.definitions.map(d => `### ${d.symbol} (${d.uri}:${d.range})\n\`\`\`\n${d.preview}\n\`\`\``).join('\n\n'));
	}
	if (ctx.diagnostics.length) {
		parts.push('## Diagnostics\n' + ctx.diagnostics.slice(0, 20).map(d => `- ${d.severity} L${d.line + 1}: ${d.message}`).join('\n'));
	}
	return parts.join('\n\n');
}
