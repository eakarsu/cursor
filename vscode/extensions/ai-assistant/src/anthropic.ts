import * as vscode from 'vscode';
import { pickModel, Task } from './modelRouter';
import { callViaClaudeCode, streamViaClaudeCode, isClaudeCodeBackend } from './claudeCodeBackend';

export interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: any }
	| { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ToolDef {
	name: string;
	description: string;
	input_schema: any;
}

export interface CallOptions {
	system?: string;
	messages: AnthropicMessage[];
	maxTokens?: number;
	model?: string;
	task?: Task;
	tools?: ToolDef[];
	webSearch?: boolean;
	signal?: AbortSignal;
}

export interface CallResult {
	text: string;
	stopReason: string;
	content: ContentBlock[];
}

export interface StreamEvent {
	type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_stop' | 'message_stop' | 'error';
	text?: string;
	toolName?: string;
	toolId?: string;
	partialJson?: string;
	error?: string;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_VERSION = '2023-06-01';

function getKey(provider: 'anthropic' | 'openai'): string | undefined {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	if (provider === 'anthropic') {
		return cfg.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY;
	}
	return cfg.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY;
}

function providerForModel(model: string): 'anthropic' | 'openai' {
	return model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') ? 'openai' : 'anthropic';
}

export async function call(opts: CallOptions): Promise<CallResult> {
	const choice = opts.model
		? { provider: providerForModel(opts.model), model: opts.model }
		: pickModel(opts.task ?? 'chat');
	if (choice.provider === 'anthropic' && isClaudeCodeBackend()) {
		if (opts.tools?.length) {
			throw new Error('Tool use is not supported in Claude Code backend. Switch aiAssistant.backend to "api" or set ANTHROPIC_API_KEY.');
		}
		return callViaClaudeCode({ ...opts, model: choice.model });
	}
	if (choice.provider === 'anthropic') {
		return callAnthropic(opts, choice.model);
	}
	return callOpenAI(opts, choice.model);
}

async function callAnthropic(opts: CallOptions, model: string): Promise<CallResult> {
	const apiKey = getKey('anthropic');
	if (!apiKey) {
		throw new Error('No Anthropic API key. Set aiAssistant.apiKey or ANTHROPIC_API_KEY.');
	}
	const body: any = {
		model,
		max_tokens: opts.maxTokens ?? 1024,
		system: opts.system,
		messages: opts.messages,
	};
	if (opts.tools?.length) { body.tools = opts.tools; }
	const res = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
		},
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok) {
		throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
	}
	const json: any = await res.json();
	const content = (json.content ?? []) as ContentBlock[];
	const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
	return { text, stopReason: json.stop_reason ?? '', content };
}

async function callOpenAI(opts: CallOptions, model: string): Promise<CallResult> {
	const apiKey = getKey('openai');
	if (!apiKey) {
		throw new Error('No OpenAI API key.');
	}
	const messages = [
		...(opts.system ? [{ role: 'system', content: opts.system }] : []),
		...opts.messages.map(m => ({
			role: m.role,
			content: typeof m.content === 'string' ? m.content : m.content.map(c => (c as any).text ?? '').join(''),
		})),
	];
	const res = await fetch(OPENAI_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 1024 }),
		signal: opts.signal,
	});
	if (!res.ok) { throw new Error(`OpenAI ${res.status}: ${await res.text()}`); }
	const json: any = await res.json();
	const text = json.choices?.[0]?.message?.content ?? '';
	return { text, stopReason: json.choices?.[0]?.finish_reason ?? '', content: [{ type: 'text', text }] };
}

export async function* stream(opts: CallOptions): AsyncGenerator<StreamEvent, CallResult, void> {
	const choice = opts.model
		? { provider: providerForModel(opts.model), model: opts.model }
		: pickModel(opts.task ?? 'chat');
	if (choice.provider === 'anthropic' && isClaudeCodeBackend()) {
		if (opts.tools?.length) {
			throw new Error('Tool use is not supported in Claude Code backend.');
		}
		return yield* streamViaClaudeCode({ ...opts, model: choice.model });
	}
	if (choice.provider !== 'anthropic') {
		// OpenAI streaming is similar but not implemented; fall back to non-stream + emit one delta
		const r = await callOpenAI(opts, choice.model);
		yield { type: 'text_delta', text: r.text };
		yield { type: 'message_stop' };
		return r;
	}
	const apiKey = getKey('anthropic');
	if (!apiKey) { throw new Error('No Anthropic API key.'); }

	const body: any = {
		model: choice.model,
		max_tokens: opts.maxTokens ?? 1024,
		system: opts.system,
		messages: opts.messages,
		stream: true,
	};
	const tools: any[] = opts.tools ? [...opts.tools] : [];
	if (opts.webSearch) { tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }); }
	if (tools.length) { body.tools = tools; }

	const res = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
		},
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok || !res.body) { throw new Error(`Anthropic stream ${res.status}: ${await res.text()}`); }

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const blocks: ContentBlock[] = [];
	const partialTools = new Map<number, { id: string; name: string; jsonBuf: string }>();
	let stopReason = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const line = event.split('\n').find(l => l.startsWith('data: '));
				if (!line) { continue; }
				const data = line.slice(6).trim();
				if (data === '[DONE]') { continue; }
				let payload: any;
				try { payload = JSON.parse(data); } catch { continue; }
				switch (payload.type) {
					case 'content_block_start': {
						const cb = payload.content_block;
						if (cb?.type === 'text') {
							blocks[payload.index] = { type: 'text', text: '' };
						} else if (cb?.type === 'tool_use') {
							blocks[payload.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
							partialTools.set(payload.index, { id: cb.id, name: cb.name, jsonBuf: '' });
							yield { type: 'tool_use_start', toolId: cb.id, toolName: cb.name };
						}
						break;
					}
					case 'content_block_delta': {
						const d = payload.delta;
						if (d?.type === 'text_delta') {
							const b = blocks[payload.index] as any;
							if (b?.type === 'text') { b.text += d.text; }
							yield { type: 'text_delta', text: d.text };
						} else if (d?.type === 'input_json_delta') {
							const t = partialTools.get(payload.index);
							if (t) { t.jsonBuf += d.partial_json ?? ''; }
							yield { type: 'tool_use_delta', partialJson: d.partial_json };
						}
						break;
					}
					case 'content_block_stop': {
						const t = partialTools.get(payload.index);
						if (t) {
							const b = blocks[payload.index] as any;
							try { b.input = t.jsonBuf ? JSON.parse(t.jsonBuf) : {}; } catch { b.input = {}; }
							yield { type: 'tool_use_stop', toolId: t.id };
							partialTools.delete(payload.index);
						}
						break;
					}
					case 'message_delta': {
						stopReason = payload.delta?.stop_reason ?? stopReason;
						break;
					}
					case 'message_stop': {
						yield { type: 'message_stop' };
						break;
					}
					case 'error': {
						yield { type: 'error', error: payload.error?.message ?? 'unknown' };
						break;
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	const text = blocks.filter(b => b.type === 'text').map(b => (b as any).text).join('');
	return { text, stopReason, content: blocks };
}

export async function callClaude(opts: { system?: string; messages: AnthropicMessage[]; maxTokens?: number; model?: string; signal?: AbortSignal }): Promise<string> {
	const r = await call({ ...opts, task: 'chat' });
	return r.text;
}
