import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ToolDef } from './anthropic';

interface ServerSpec {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: any; }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: any; error?: { code: number; message: string }; }

interface Transport {
	send(method: string, params?: any): Promise<any>;
	dispose(): void;
}

class StdioTransport implements Transport {
	private proc: cp.ChildProcessWithoutNullStreams;
	private buf = '';
	private handlers = new Map<number, (r: JsonRpcResponse) => void>();
	private nextId = 1;

	constructor(spec: ServerSpec) {
		this.proc = cp.spawn(spec.command!, spec.args ?? [], {
			env: { ...process.env, ...(spec.env ?? {}) },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc.stdout.setEncoding('utf8');
		this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
		this.proc.stderr.on('data', () => { /* ignore */ });
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let idx;
		while ((idx = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, idx).trim();
			this.buf = this.buf.slice(idx + 1);
			if (!line) { continue; }
			try {
				const msg = JSON.parse(line) as JsonRpcResponse;
				if (typeof msg.id === 'number') {
					this.handlers.get(msg.id)?.(msg);
					this.handlers.delete(msg.id);
				}
			} catch { /* ignore */ }
		}
	}

	send(method: string, params?: any): Promise<any> {
		const id = this.nextId++;
		const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => { this.handlers.delete(id); reject(new Error('MCP timeout')); }, 30000);
			this.handlers.set(id, (r) => {
				clearTimeout(t);
				if (r.error) { reject(new Error(r.error.message)); } else { resolve(r.result); }
			});
			this.proc.stdin.write(JSON.stringify(req) + '\n');
		});
	}

	dispose(): void { try { this.proc.kill(); } catch { /* ignore */ } }
}

class HttpSseTransport implements Transport {
	private nextId = 1;
	private sseAbort: AbortController | undefined;
	private sessionId: string | undefined;

	constructor(private spec: ServerSpec) {
		// Streamable HTTP transport: POSTs use /messages, server may push via SSE on /sse.
		void this.openSse().catch(() => undefined);
	}

	private async openSse(): Promise<void> {
		if (!this.spec.url) { return; }
		this.sseAbort = new AbortController();
		try {
			const res = await fetch(this.spec.url, {
				method: 'GET',
				headers: { accept: 'text/event-stream', ...(this.spec.headers ?? {}) },
				signal: this.sseAbort.signal,
			});
			if (!res.ok || !res.body) { return; }
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buf += decoder.decode(value, { stream: true });
				let idx;
				while ((idx = buf.indexOf('\n\n')) >= 0) {
					const line = buf.slice(0, idx).split('\n').find(l => l.startsWith('data: '));
					buf = buf.slice(idx + 2);
					if (!line) { continue; }
					// Notifications ignored in this minimal client
					try { JSON.parse(line.slice(6)); } catch { /* skip */ }
				}
			}
		} catch { /* SSE unsupported or closed */ }
	}

	async send(method: string, params?: any): Promise<any> {
		if (!this.spec.url) { throw new Error('No URL'); }
		const id = this.nextId++;
		const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept: 'application/json',
			...(this.spec.headers ?? {}),
		};
		if (this.sessionId) { headers['mcp-session-id'] = this.sessionId; }
		const res = await fetch(this.spec.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(req),
		});
		const sid = res.headers.get('mcp-session-id');
		if (sid) { this.sessionId = sid; }
		if (!res.ok) { throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`); }
		const json = await res.json() as JsonRpcResponse;
		if (json.error) { throw new Error(json.error.message); }
		return json.result;
	}

	dispose(): void { this.sseAbort?.abort(); }
}

interface Server {
	name: string;
	transport: Transport;
	tools: ToolDef[];
	resources: Array<{ uri: string; name?: string; description?: string }>;
}

const servers = new Map<string, Server>();

export async function connectAll(): Promise<void> {
	disconnectAll();
	const cfg = vscode.workspace.getConfiguration('aiAssistant').get<Record<string, ServerSpec>>('mcp.servers') ?? {};
	for (const [name, spec] of Object.entries(cfg)) {
		try {
			const transport: Transport = spec.url ? new HttpSseTransport(spec) : new StdioTransport(spec);
			await transport.send('initialize', {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'ai-code', version: '0.0.1' },
			});
			await transport.send('notifications/initialized').catch(() => undefined);
			const list = await transport.send('tools/list').catch(() => ({ tools: [] }));
			const tools: ToolDef[] = (list?.tools ?? []).map((t: any) => ({
				name: `mcp__${name}__${t.name}`,
				description: t.description ?? '',
				input_schema: t.inputSchema ?? { type: 'object', properties: {} },
			}));
			let resources: any[] = [];
			try {
				const lr = await transport.send('resources/list');
				resources = lr?.resources ?? [];
			} catch { /* server may not support resources */ }
			servers.set(name, { name, transport, tools, resources });
		} catch (e: any) {
			vscode.window.showWarningMessage(`MCP ${name}: ${e?.message ?? e}`);
		}
	}
}

export function disconnectAll(): void {
	for (const s of servers.values()) { s.transport.dispose(); }
	servers.clear();
}

export async function getMcpTools(): Promise<ToolDef[]> {
	const out: ToolDef[] = [];
	for (const s of servers.values()) { out.push(...s.tools); }
	return out;
}

export async function callMcpTool(qualifiedName: string, input: any): Promise<{ content: string; isError?: boolean }> {
	const m = qualifiedName.match(/^mcp__([^_]+)__(.+)$/);
	if (!m) { return { content: `Bad MCP name: ${qualifiedName}`, isError: true }; }
	const [, server, tool] = m;
	const s = servers.get(server);
	if (!s) { return { content: `MCP server not connected: ${server}`, isError: true }; }
	try {
		const r = await s.transport.send('tools/call', { name: tool, arguments: input });
		const blocks = r?.content ?? [];
		const text = blocks.map((b: any) => b.text ?? '').join('\n');
		return { content: text || '(empty)', isError: r?.isError };
	} catch (e: any) {
		return { content: String(e?.message ?? e), isError: true };
	}
}

export function listResources(): Array<{ server: string; uri: string; name?: string; description?: string }> {
	const out: Array<{ server: string; uri: string; name?: string; description?: string }> = [];
	for (const s of servers.values()) {
		for (const r of s.resources) { out.push({ server: s.name, ...r }); }
	}
	return out;
}

export async function readResource(server: string, uri: string): Promise<string> {
	const s = servers.get(server);
	if (!s) { throw new Error(`MCP server not connected: ${server}`); }
	const r = await s.transport.send('resources/read', { uri });
	const contents = r?.contents ?? [];
	return contents.map((c: any) => c.text ?? '').join('\n');
}
