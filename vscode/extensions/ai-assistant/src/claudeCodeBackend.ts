import * as cp from 'child_process';
import * as vscode from 'vscode';
import { AnthropicMessage, CallOptions, CallResult, StreamEvent } from './anthropic';

// Routes chat/completion through the Claude Code CLI so requests bill against
// the user's Max subscription instead of Anthropic API credits.

function modelAlias(opts: CallOptions): string {
	// Claude Code CLI accepts both aliases ('opus', 'sonnet', 'haiku') and full
	// names ('claude-opus-4-7'). Prefer the full name when present so the user
	// gets exactly the model configured in aiAssistant.models.*.
	if (opts.model) { return opts.model; }
	switch (opts.task) {
		case 'completions': return 'claude-haiku-4-5-20251001';
		case 'cmdK': return 'claude-sonnet-4-6';
		case 'agent':
		case 'chat':
		default: return 'claude-opus-4-7';
	}
}

function flattenMessages(messages: AnthropicMessage[]): string {
	return messages.map(m => {
		const text = typeof m.content === 'string'
			? m.content
			: m.content.map(c => (c as any).text ?? '').join('');
		return `[${m.role}]\n${text}`;
	}).join('\n\n');
}

function claudePath(): string {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	return cfg.get<string>('claudeCli', 'claude');
}

function spawnEnv(): NodeJS.ProcessEnv {
	// VS Code's extension host on macOS GUI launches often inherits a stripped
	// PATH that doesn't include Homebrew. Make sure claude is findable.
	const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.nvm/versions/node/${process.versions.node}/bin`];
	const path = [process.env.PATH, ...extra].filter(Boolean).join(':');
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
	// Force the CLI to use Max-subscription OAuth (keychain) by stripping any
	// API-key envs the parent shell may have set (e.g. from server/.env).
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.CLAUDE_API_KEY;
	return env;
}

// Disable every built-in tool when using the CLI for chat/composer so the
// model produces text only (the CLI defaults to running tools, which would
// short-circuit the Composer's JSON-output flow).
const ALL_BUILTIN_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit,BashOutput,KillBash,SlashCommand';

function buildArgs(opts: CallOptions, format: 'text' | 'stream-json'): string[] {
	// NOTE: do NOT pass --bare here. --bare forces ANTHROPIC_API_KEY auth and
	// disables OAuth/keychain, which is what we need for Max-subscription users.
	// When webSearch is requested, leave WebSearch/WebFetch enabled so the CLI
	// can browse for the user.
	// WebSearch/WebFetch are deferred tools in modern Claude Code — the model
	// can only call them after loading via ToolSearch. So when webSearch is on,
	// keep ToolSearch + WebSearch + WebFetch allowed and prompt the model.
	const disallowed = opts.webSearch
		? ALL_BUILTIN_TOOLS.split(',').filter(t => t !== 'WebSearch' && t !== 'WebFetch').join(',')
		: ALL_BUILTIN_TOOLS;
	const args = [
		'--print',
		'--no-session-persistence',
		'--disable-slash-commands',
		'--disallowed-tools', disallowed,
		'--model', modelAlias(opts),
		'--output-format', format,
	];
	if (opts.webSearch) {
		args.push('--allowed-tools', 'WebSearch,WebFetch,ToolSearch', '--permission-mode', 'bypassPermissions');
	}
	const sys = opts.webSearch
		? `${opts.system ?? ''}\n\nIMPORTANT: For this turn, you MUST use the web. WebSearch and WebFetch are deferred tools — first call ToolSearch with query "select:WebSearch,WebFetch" to load their schemas, then call WebSearch with the user's query. Cite sources in your final answer.`.trim()
		: opts.system;
	if (sys) {
		args.push('--system-prompt', sys);
	}
	if (format === 'stream-json') {
		// CLI requires --verbose when combining --print with --output-format=stream-json.
		args.push('--verbose', '--include-partial-messages');
	}
	return args;
}

export type ClaudeAgentEvent =
	| { type: 'text'; text: string }
	| { type: 'tool_call'; tool: string; input: any }
	| { type: 'tool_result'; tool: string; output: string; isError?: boolean }
	| { type: 'done' }
	| { type: 'error'; text: string };

export async function streamAgentViaClaudeCode(
	task: string,
	model: string,
	onEvent: (e: ClaudeAgentEvent) => void,
	signal: AbortSignal,
	autoApprove: boolean,
	allowedTools?: string
): Promise<void> {
	const args: string[] = [
		'--print',
		'--no-session-persistence',
		'--model', model,
		'--output-format', 'stream-json',
		'--verbose',
	];
	if (allowedTools && allowedTools.trim()) {
		args.push('--allowed-tools', allowedTools.trim());
	}
	if (autoApprove) { args.push('--permission-mode', 'bypassPermissions'); }
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const child = cp.spawn(claudePath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv(), cwd });
	child.stdin.end(task);

	const onAbort = (): void => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
	signal.addEventListener('abort', onAbort);

	let stderr = '';
	child.stderr.on('data', d => { stderr += d.toString(); });

	const toolNameById = new Map<string, string>();
	let buf = '';

	const handle = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed) { return; }
		let payload: any;
		try { payload = JSON.parse(trimmed); } catch { return; }

		if (payload.type === 'assistant' && payload.message?.content) {
			for (const block of payload.message.content) {
				if (block.type === 'text' && block.text) {
					onEvent({ type: 'text', text: block.text });
				} else if (block.type === 'tool_use') {
					if (block.id) { toolNameById.set(block.id, block.name); }
					onEvent({ type: 'tool_call', tool: block.name, input: block.input ?? {} });
				}
			}
		} else if (payload.type === 'user' && payload.message?.content) {
			for (const block of payload.message.content) {
				if (block.type === 'tool_result') {
					const id = block.tool_use_id;
					const tool = (id && toolNameById.get(id)) || 'tool';
					const out = extractText(block.content);
					onEvent({ type: 'tool_result', tool, output: out, isError: !!block.is_error });
				}
			}
		} else if (payload.type === 'result') {
			if (payload.subtype === 'success' || payload.subtype === 'end_turn') {
				onEvent({ type: 'done' });
			} else if (payload.is_error || payload.subtype === 'error') {
				onEvent({ type: 'error', text: payload.error?.message ?? payload.subtype ?? 'error' });
			}
		}
	};

	child.stdout.on('data', d => {
		buf += d.toString();
		let idx;
		while ((idx = buf.indexOf('\n')) >= 0) {
			handle(buf.slice(0, idx));
			buf = buf.slice(idx + 1);
		}
	});

	await new Promise<void>((resolve) => {
		child.on('error', e => { onEvent({ type: 'error', text: e.message }); resolve(); });
		child.on('close', code => {
			if (buf.trim()) { handle(buf); buf = ''; }
			if (code !== 0) {
				const detail = (stderr || '(no stderr)').slice(0, 600);
				onEvent({ type: 'error', text: `claude exited ${code}: ${detail}` });
			}
			signal.removeEventListener('abort', onAbort);
			resolve();
		});
	});
}

function extractText(content: any): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map((c: any) => (c?.type === 'text' ? c.text : (typeof c === 'string' ? c : ''))).join('');
	}
	return '';
}

export async function callViaClaudeCode(opts: CallOptions): Promise<CallResult> {
	const args = buildArgs(opts, 'text');
	const prompt = flattenMessages(opts.messages);
	const text = await runClaude(args, prompt, opts.signal);
	return { text, stopReason: 'end_turn', content: [{ type: 'text', text }] };
}

export async function* streamViaClaudeCode(
	opts: CallOptions
): AsyncGenerator<StreamEvent, CallResult, void> {
	const args = buildArgs(opts, 'stream-json');
	const prompt = flattenMessages(opts.messages);
	const child = cp.spawn(claudePath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv() });
	child.stdin.end(prompt);

	const onAbort = (): void => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
	opts.signal?.addEventListener('abort', onAbort);

	let collected = '';
	let stopReason = '';
	let stderr = '';
	child.stderr.on('data', d => { stderr += d.toString(); });

	const queue: StreamEvent[] = [];
	let resolveNext: (() => void) | undefined;
	let finished = false;
	let err: Error | undefined;
	let buf = '';

	const onLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed) { return; }
		let payload: any;
		try { payload = JSON.parse(trimmed); } catch { return; }
		// Claude Code stream-json emits message envelopes. We extract assistant text deltas.
		if (payload.type === 'stream_event' && payload.event?.type === 'content_block_delta') {
			const d = payload.event.delta;
			if (d?.type === 'text_delta' && typeof d.text === 'string') {
				collected += d.text;
				queue.push({ type: 'text_delta', text: d.text });
				resolveNext?.();
			}
		} else if (payload.type === 'assistant' && payload.message?.content) {
			// Fallback: full assistant message — emit delta for any new text not seen.
			const text = (payload.message.content ?? [])
				.filter((c: any) => c.type === 'text')
				.map((c: any) => c.text)
				.join('');
			if (text && !collected) {
				collected = text;
				queue.push({ type: 'text_delta', text });
				resolveNext?.();
			}
		} else if (payload.type === 'result') {
			stopReason = payload.subtype ?? payload.stop_reason ?? 'end_turn';
		}
	};

	child.stdout.on('data', d => {
		buf += d.toString();
		let idx;
		while ((idx = buf.indexOf('\n')) >= 0) {
			onLine(buf.slice(0, idx));
			buf = buf.slice(idx + 1);
		}
	});
	child.on('error', e => { err = e; finished = true; resolveNext?.(); });
	child.on('close', code => {
		if (buf.trim()) { onLine(buf); buf = ''; }
		if (code !== 0 && !err) {
			const detail = (stderr || collected || '(no output)').slice(0, 800);
			err = new Error(`claude exited ${code}. cli=${claudePath()} args=${JSON.stringify(args)} detail=${detail}`);
		}
		finished = true;
		queue.push({ type: 'message_stop' });
		resolveNext?.();
	});

	try {
		while (true) {
			while (queue.length === 0 && !finished) {
				await new Promise<void>(r => { resolveNext = r; });
				resolveNext = undefined;
			}
			while (queue.length) {
				const ev = queue.shift()!;
				yield ev;
				if (ev.type === 'message_stop') { break; }
			}
			if (finished && queue.length === 0) { break; }
		}
		if (err) { throw err; }
	} finally {
		opts.signal?.removeEventListener('abort', onAbort);
	}

	return { text: collected, stopReason, content: [{ type: 'text', text: collected }] };
}

function runClaude(args: string[], prompt: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(claudePath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv() });
		let out = '';
		let stderr = '';
		child.stdout.on('data', d => { out += d.toString(); });
		child.stderr.on('data', d => { stderr += d.toString(); });
		child.on('error', e => reject(new Error(`spawn ${claudePath()}: ${e.message}`)));
		child.on('close', code => {
			if (code !== 0) {
				const detail = (stderr || out || '(no output)').slice(0, 800);
				reject(new Error(`claude exited ${code}. cli=${claudePath()} args=${JSON.stringify(args)} detail=${detail}`));
				return;
			}
			resolve(out.trim());
		});
		const onAbort = (): void => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
		signal?.addEventListener('abort', onAbort);
		child.stdin.end(prompt);
	});
}

export function isClaudeCodeBackend(): boolean {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	return cfg.get<string>('backend', 'api') === 'claudeCode';
}
