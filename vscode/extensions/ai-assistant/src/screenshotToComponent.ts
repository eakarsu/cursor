import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { call } from './anthropic';

const FRAMEWORKS: { label: string; value: string; lang: string }[] = [
	{ label: 'React + TailwindCSS (.tsx)', value: 'React + TailwindCSS', lang: 'typescriptreact' },
	{ label: 'React + plain CSS (.tsx)', value: 'React + plain CSS', lang: 'typescriptreact' },
	{ label: 'Vue 3 (<script setup>)', value: 'Vue 3 with <script setup>', lang: 'vue' },
	{ label: 'Svelte', value: 'Svelte', lang: 'svelte' },
	{ label: 'Plain HTML + CSS', value: 'plain HTML + inline CSS', lang: 'html' },
];

export async function screenshotToComponent(): Promise<void> {
	const uri = await vscode.window.showOpenDialog({
		canSelectMany: false,
		filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
		title: 'Pick a screenshot to turn into a component',
	});
	if (!uri?.length) { return; }
	const fwk = await vscode.window.showQuickPick(FRAMEWORKS, { placeHolder: 'Target framework' });
	if (!fwk) { return; }

	const buf = await fs.readFile(uri[0].fsPath);
	const ext = uri[0].fsPath.toLowerCase().split('.').pop() ?? 'png';
	const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
	const data = buf.toString('base64');

	const code = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'AI: generating component from screenshot...' },
		async () => {
			const r = await call({
				system: `You are a senior frontend engineer. Given a UI screenshot, produce a single self-contained component file in ${fwk.value}. Match layout, spacing, colors, typography, and interactive cues. Use semantic markup. Output ONLY code — no fences, no explanation.`,
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'base64', media_type: mime, data } },
							{ type: 'text', text: `Build a ${fwk.value} component from this screenshot. Make sensible names. Use placeholder data for text where needed.` },
						],
					},
				],
				maxTokens: 4000,
				task: 'cmdK',
			});
			return stripFences(r.text);
		},
	);
	if (!code) {
		vscode.window.showWarningMessage('AI: no output from model.');
		return;
	}

	const doc = await vscode.workspace.openTextDocument({ content: code, language: fwk.lang });
	await vscode.window.showTextDocument(doc, { preview: false });
}

function stripFences(s: string): string {
	const m = s.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/);
	return m ? m[1] : s;
}
