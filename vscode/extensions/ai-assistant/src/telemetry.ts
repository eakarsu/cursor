import * as vscode from 'vscode';

interface Event {
	ts: number;
	kind: string;
	props?: Record<string, any>;
}

class Telemetry {
	private queue: Event[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private endpoint: string | undefined;
	private clientId: string;

	constructor() {
		this.clientId = String(Math.random()).slice(2);
	}

	configure(): void {
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		this.endpoint = cfg.get<string>('telemetryEndpoint') || undefined;
	}

	track(kind: string, props?: Record<string, any>): void {
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		if (cfg.get<boolean>('privacyMode', false)) { return; }
		if (!cfg.get<boolean>('telemetry.enabled', false)) { return; }
		this.queue.push({ ts: Date.now(), kind, props });
		this.scheduleFlush();
	}

	error(scope: string, err: any): void {
		this.track('error', { scope, message: String(err?.message ?? err), stack: err?.stack?.toString().slice(0, 1000) });
	}

	private scheduleFlush(): void {
		if (this.flushTimer) { return; }
		this.flushTimer = setTimeout(() => { void this.flush(); }, 5000);
	}

	private async flush(): Promise<void> {
		this.flushTimer = undefined;
		if (!this.endpoint || this.queue.length === 0) { return; }
		const batch = this.queue.splice(0);
		try {
			await fetch(this.endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ clientId: this.clientId, events: batch }),
			});
		} catch {
			// re-queue, but bound size
			this.queue = [...batch.slice(-200), ...this.queue];
		}
	}
}

export const telemetry = new Telemetry();
