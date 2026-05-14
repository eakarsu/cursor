import * as vscode from 'vscode';
import { Agent, AgentEvent } from './agent';
import { CodebaseIndex } from './codebaseIndex';

interface BackgroundJob {
	id: string;
	task: string;
	status: 'running' | 'done' | 'error';
	events: AgentEvent[];
	abort: AbortController;
	startedAt: number;
}

const jobs = new Map<string, BackgroundJob>();

export function registerBackground(context: vscode.ExtensionContext, index: CodebaseIndex): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.runAgent', async () => {
			const task = await vscode.window.showInputBox({
				prompt: 'Describe a task for the background agent',
				placeHolder: 'e.g. "fix all TypeScript errors in src/"',
			});
			if (!task) { return; }
			startJob(task, index);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.listJobs', () => {
			showJobsQuickPick();
		})
	);
}

function startJob(task: string, index: CodebaseIndex): BackgroundJob {
	const id = String(Date.now());
	const abort = new AbortController();
	const job: BackgroundJob = { id, task, status: 'running', events: [], abort, startedAt: Date.now() };
	jobs.set(id, job);

	const agent = new Agent(index);
	const status = vscode.window.setStatusBarMessage(`AI: ${task.slice(0, 40)}…`);
	(async () => {
		try {
			await agent.run(
				task,
				e => {
					job.events.push(e);
					if (e.type === 'done') { job.status = 'done'; }
					if (e.type === 'error') { job.status = 'error'; }
				},
				async () => true, // background jobs auto-approve; surface via notification
				abort.signal
			);
		} finally {
			status.dispose();
			vscode.window.showInformationMessage(`AI job ${job.status === 'done' ? 'finished' : 'stopped'}: ${task.slice(0, 60)}`);
		}
	})();
	return job;
}

async function showJobsQuickPick(): Promise<void> {
	const items = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(j => ({
		label: `[${j.status}] ${j.task.slice(0, 80)}`,
		detail: `${j.events.length} events`,
		id: j.id,
	}));
	if (!items.length) { vscode.window.showInformationMessage('No background jobs.'); return; }
	const pick = await vscode.window.showQuickPick(items);
	if (!pick) { return; }
	const job = jobs.get(pick.id);
	if (!job) { return; }
	const doc = await vscode.workspace.openTextDocument({
		content: job.events.map(e => `[${e.type}] ${e.tool ?? ''} ${e.text ?? e.output ?? JSON.stringify(e.input ?? '')}`).join('\n'),
		language: 'log',
	});
	await vscode.window.showTextDocument(doc);
}
