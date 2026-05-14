import * as vscode from 'vscode';
import { call, AnthropicMessage, ContentBlock, ToolDef } from './anthropic';
import { TOOLS, runTool, ApprovalFn } from './tools';
import { loadRulesAndMemory } from './rules';
import { CodebaseIndex } from './codebaseIndex';
import { getMcpTools, callMcpTool } from './mcp';
import { checkpoints } from './checkpoints';
import { buildFileDiffs, showDiffStaging } from './diffStaging';
import { isClaudeCodeBackend, streamAgentViaClaudeCode } from './claudeCodeBackend';

export interface AgentEvent {
	type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'checkpoint';
	text?: string;
	tool?: string;
	input?: any;
	output?: string;
	checkpointId?: string;
}

const SYSTEM = `You are an autonomous coding agent inside an editor. You can read, write, search, and execute. Plan briefly, then act with tools. After each tool result, decide the next step. You may emit MULTIPLE tool_use blocks in one turn to run them in parallel — use this when independent (e.g. reading 3 files at once). Stop when done with a short summary.`;

export class Agent {
	constructor(private index: CodebaseIndex) { }

	async run(task: string, onEvent: (e: AgentEvent) => void, approve: ApprovalFn, signal: AbortSignal): Promise<void> {
		if (isClaudeCodeBackend()) {
			return this.runViaClaudeCode(task, onEvent, signal);
		}
		const rules = await loadRulesAndMemory();
		await this.index.ensureBuilt();
		const ctx = await this.index.formatContext(task, 4);
		const system = [SYSTEM, rules, ctx ? `# Likely-relevant code\n${ctx}` : ''].filter(Boolean).join('\n\n');
		const mcpTools = await getMcpTools();
		const allTools: ToolDef[] = [...TOOLS, ...mcpTools];
		const messages: AnthropicMessage[] = [{ role: 'user', content: task }];
		const touchedFiles = new Set<string>();
		const cp = await checkpoints.snapshot(`agent: ${task.slice(0, 60)}`, []);
		onEvent({ type: 'checkpoint', checkpointId: cp.id });

		for (let step = 0; step < 25; step++) {
			if (signal.aborted) { onEvent({ type: 'error', text: 'Aborted.' }); break; }
			onEvent({ type: 'thinking' });
			let result;
			try {
				result = await call({ system, messages, tools: allTools, maxTokens: 4096, task: 'agent', signal });
			} catch (e: any) {
				onEvent({ type: 'error', text: String(e?.message ?? e) });
				return;
			}

			const toolUses = result.content.filter((b: ContentBlock) => b.type === 'tool_use') as Array<Extract<ContentBlock, { type: 'tool_use' }>>;
			if (result.text) { onEvent({ type: 'text', text: result.text }); }
			messages.push({ role: 'assistant', content: result.content });

			if (!toolUses.length) {
				onEvent({ type: 'done' });
				break;
			}

			// Snapshot any files about to be touched (write_file, edit_file)
			const willTouch = new Set<string>();
			for (const tu of toolUses) {
				if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input?.path === 'string') {
					willTouch.add(tu.input.path);
					touchedFiles.add(tu.input.path);
				}
			}
			if (willTouch.size) {
				await checkpoints.snapshot(`step ${step + 1}`, [...willTouch]).then(c =>
					onEvent({ type: 'checkpoint', checkpointId: c.id })
				);
			}

			// Run tools in parallel
			const results = await Promise.all(toolUses.map(async (tu) => {
				onEvent({ type: 'tool_call', tool: tu.name, input: tu.input });
				let out: { content: string; isError?: boolean };
				if (tu.name.startsWith('mcp__')) {
					out = await callMcpTool(tu.name, tu.input);
				} else {
					out = await runTool(tu.name, tu.input, approve);
				}
				onEvent({ type: 'tool_result', tool: tu.name, output: out.content });
				return { id: tu.id, content: out.content, isError: out.isError };
			}));

			const toolResults: ContentBlock[] = results.map(r => ({
				type: 'tool_result' as const,
				tool_use_id: r.id,
				content: r.content,
				is_error: r.isError,
			}));
			messages.push({ role: 'user', content: toolResults });
		}

		// Post-run diff staging
		if (touchedFiles.size) {
			const cpFinal = await checkpoints.snapshot('final', [...touchedFiles]);
			void cpFinal;
			const diffs = await buildFileDiffs(cp);
			await showDiffStaging(diffs, () => { /* done */ });
		}
	}

	private async runViaClaudeCode(task: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		const model = cfg.get<string>('models.chat', 'claude-opus-4-7');
		const autoApprove = cfg.get<boolean>('agent.claudeCodeAutoApprove', true);
		const allowedTools = cfg.get<string>('agent.allowedTools', '');
		const cp = await checkpoints.snapshot(`agent: ${task.slice(0, 60)}`, []);
		onEvent({ type: 'checkpoint', checkpointId: cp.id });
		onEvent({ type: 'thinking' });
		await streamAgentViaClaudeCode(task, model, (e) => {
			if (e.type === 'text') { onEvent({ type: 'text', text: e.text }); }
			else if (e.type === 'tool_call') { onEvent({ type: 'tool_call', tool: e.tool, input: e.input }); }
			else if (e.type === 'tool_result') { onEvent({ type: 'tool_result', tool: e.tool, output: e.output }); }
			else if (e.type === 'done') { onEvent({ type: 'done' }); }
			else if (e.type === 'error') { onEvent({ type: 'error', text: e.text }); }
		}, signal, autoApprove, allowedTools);
	}
}
