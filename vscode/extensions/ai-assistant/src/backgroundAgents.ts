import * as vscode from 'vscode';
import { Agent, AgentEvent } from './agent';
import { CodebaseIndex } from './codebaseIndex';

interface Job {
	id: string;
	task: string;
	status: 'running' | 'done' | 'error' | 'aborted';
	startedAt: number;
	endedAt?: number;
	output: string;
	abort: AbortController;
}

class BackgroundAgents {
	private jobs = new Map<string, Job>();
	private channel = vscode.window.createOutputChannel('AI Background Agents');
	private statusItem: vscode.StatusBarItem | undefined;

	async runFromInput(index: CodebaseIndex): Promise<void> {
		const task = await vscode.window.showInputBox({
			prompt: 'Background agent task',
			placeHolder: 'Add unit tests for src/utils.ts',
		});
		if (!task) { return; }
		this.start(task, index);
	}

	start(task: string, index: CodebaseIndex): string {
		const id = String(Date.now()).slice(-6);
		const job: Job = { id, task, status: 'running', startedAt: Date.now(), output: '', abort: new AbortController() };
		this.jobs.set(id, job);
		this.updateStatus();
		this.channel.appendLine(`[${id}] start: ${task}`);

		void (async () => {
			const agent = new Agent(index);
			try {
				await agent.run(task, (e: AgentEvent) => this.onEvent(job, e), async () => true, job.abort.signal);
				if (job.status === 'running') { job.status = 'done'; }
			} catch (e: any) {
				job.status = 'error';
				job.output += `\n[error] ${e?.message ?? e}`;
			} finally {
				job.endedAt = Date.now();
				this.updateStatus();
				const dur = ((job.endedAt - job.startedAt) / 1000).toFixed(1);
				this.channel.appendLine(`[${id}] ${job.status} in ${dur}s`);
				vscode.window.showInformationMessage(`Background agent ${job.status}: ${task.slice(0, 60)}`, 'Show').then(c => {
					if (c === 'Show') { this.showPanel(); }
				});
			}
		})();
		return id;
	}

	private onEvent(job: Job, e: AgentEvent): void {
		if (e.type === 'text' && e.text) {
			job.output += e.text;
			this.channel.append(`[${job.id}] ${e.text}`);
		} else if (e.type === 'tool_call') {
			this.channel.appendLine(`[${job.id}] tool: ${e.tool} ${JSON.stringify(e.input).slice(0, 200)}`);
		} else if (e.type === 'error') {
			job.output += `\n[error] ${e.text}`;
			this.channel.appendLine(`[${job.id}] error: ${e.text}`);
		}
	}

	abort(id: string): void {
		const j = this.jobs.get(id);
		if (!j) { return; }
		j.abort.abort();
		j.status = 'aborted';
		this.updateStatus();
	}

	showPanel(): void {
		this.channel.show();
		const lines: string[] = ['', '=== Background Agents ==='];
		for (const j of this.jobs.values()) {
			const dur = ((j.endedAt ?? Date.now()) - j.startedAt) / 1000;
			lines.push(`[${j.id}] ${j.status.padEnd(8)} ${dur.toFixed(1)}s  ${j.task.slice(0, 80)}`);
		}
		this.channel.appendLine(lines.join('\n'));
	}

	private updateStatus(): void {
		if (!this.statusItem) {
			this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
			this.statusItem.command = 'aiAssistant.showBackgroundAgents';
		}
		const running = [...this.jobs.values()].filter(j => j.status === 'running').length;
		if (running > 0) {
			this.statusItem.text = `$(sync~spin) ${running} agent${running > 1 ? 's' : ''}`;
			this.statusItem.tooltip = 'Background agents running. Click to view.';
			this.statusItem.show();
		} else {
			this.statusItem.hide();
		}
	}
}

export const backgroundAgents = new BackgroundAgents();
