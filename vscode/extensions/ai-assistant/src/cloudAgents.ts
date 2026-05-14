import * as vscode from 'vscode';
import { Auth } from './auth';

interface CloudJob {
	id: string;
	status: 'queued' | 'running' | 'completed' | 'failed';
	prUrl?: string;
	branch?: string;
	logUrl?: string;
}

export async function triggerCloudAgent(auth: Auth): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const endpoint = cfg.get<string>('cloudEndpoint');
	if (!endpoint) {
		vscode.window.showWarningMessage('Set aiAssistant.cloudEndpoint to use cloud agents.');
		return;
	}
	const session = auth.current();
	if (!session) {
		const choice = await vscode.window.showWarningMessage('Sign in to launch cloud agents.', 'Sign in');
		if (choice === 'Sign in') { await vscode.commands.executeCommand('aiAssistant.signIn'); }
		return;
	}

	const repo = await detectRepo();
	if (!repo) {
		vscode.window.showWarningMessage('No git remote detected. Open a workspace tracked in GitHub.');
		return;
	}

	const task = await vscode.window.showInputBox({
		prompt: 'Cloud agent task',
		placeHolder: 'e.g. "add a logout button to the navbar and open a PR"',
		ignoreFocusOut: true,
	});
	if (!task) { return; }

	const baseBranch = await vscode.window.showInputBox({
		prompt: 'Base branch',
		value: 'main',
		ignoreFocusOut: true,
	});
	if (!baseBranch) { return; }

	let job: CloudJob | undefined;
	try {
		job = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Launching cloud agent...' },
			async () => {
				const res = await fetch(`${endpoint.replace(/\/$/, '')}/agents/run`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
					body: JSON.stringify({ repo, baseBranch, task }),
				});
				if (!res.ok) { throw new Error(`${res.status}: ${await res.text()}`); }
				return await res.json() as CloudJob;
			},
		);
	} catch (e: any) {
		vscode.window.showErrorMessage(`Cloud agent: ${e?.message ?? e}`);
		return;
	}
	if (!job) { return; }

	const choice = await vscode.window.showInformationMessage(
		`Cloud agent queued (${job.id}). It'll open a PR when done.`,
		'View logs', 'OK',
	);
	if (choice === 'View logs' && job.logUrl) {
		void vscode.env.openExternal(vscode.Uri.parse(job.logUrl));
	}
}

async function detectRepo(): Promise<{ owner: string; repo: string } | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return undefined; }
	const cp = await import('child_process');
	return await new Promise(resolve => {
		cp.exec('git remote get-url origin', { cwd: root, timeout: 5000 }, (err, stdout) => {
			if (err) { resolve(undefined); return; }
			const url = stdout.trim();
			const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
			if (!m) { resolve(undefined); return; }
			resolve({ owner: m[1], repo: m[2] });
		});
	});
}
