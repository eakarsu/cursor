import * as vscode from 'vscode';

export type Task = 'chat' | 'completions' | 'cmdK' | 'agent';

export interface ModelChoice {
	provider: 'anthropic' | 'openai';
	model: string;
}

export function pickModel(task: Task): ModelChoice {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const map: Record<Task, string> = {
		chat: cfg.get('models.chat', 'claude-opus-4-7'),
		completions: cfg.get('models.completions', 'claude-haiku-4-5-20251001'),
		cmdK: cfg.get('models.cmdK', 'claude-sonnet-4-6'),
		agent: cfg.get('models.chat', 'claude-opus-4-7'),
	};
	const model = map[task];
	const provider = model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') ? 'openai' : 'anthropic';
	return { provider, model };
}
