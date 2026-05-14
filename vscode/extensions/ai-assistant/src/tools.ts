import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as cp from 'child_process';
import { ToolDef } from './anthropic';

export const TOOLS: ToolDef[] = [
	{
		name: 'read_file',
		description: 'Read a file from the workspace. Returns up to 4000 lines.',
		input_schema: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
			required: ['path'],
		},
	},
	{
		name: 'write_file',
		description: 'Create or overwrite a file. Use sparingly; prefer edit_file for modifications.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				content: { type: 'string' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'edit_file',
		description: 'Replace exactly one occurrence of old_string with new_string. Both must be exact text from the file.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				old_string: { type: 'string' },
				new_string: { type: 'string' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
	},
	{
		name: 'list_dir',
		description: 'List files and directories in a workspace path.',
		input_schema: {
			type: 'object',
			properties: { path: { type: 'string', default: '.' } },
		},
	},
	{
		name: 'grep',
		description: 'Search workspace for a regex pattern. Returns file:line:match for up to 50 hits.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: { type: 'string' },
				glob: { type: 'string', description: 'Optional glob filter.' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'run_terminal',
		description: 'Run a shell command in the workspace. Returns stdout+stderr (truncated to 8KB).',
		input_schema: {
			type: 'object',
			properties: {
				command: { type: 'string' },
				cwd: { type: 'string', description: 'Optional workspace-relative cwd.' },
			},
			required: ['command'],
		},
	},
];

function workspaceRoot(): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { throw new Error('No workspace folder open.'); }
	return root;
}

function safePath(rel: string): string {
	const root = workspaceRoot();
	const abs = path.resolve(root, rel);
	if (!abs.startsWith(root)) {
		throw new Error(`Path escapes workspace: ${rel}`);
	}
	return abs;
}

export interface ToolApprovalRequest {
	name: string;
	input: any;
	preview: string;
}

export type ApprovalFn = (req: ToolApprovalRequest) => Promise<boolean>;

export async function runTool(name: string, input: any, approve: ApprovalFn): Promise<{ content: string; isError?: boolean }> {
	try {
		switch (name) {
			case 'read_file': return await readFile(input.path);
			case 'write_file': {
				if (!await approve({ name, input, preview: `Write ${input.path} (${(input.content ?? '').length} bytes)` })) {
					return { content: 'User rejected write_file.', isError: true };
				}
				return await writeFile(input.path, input.content);
			}
			case 'edit_file': {
				if (!await approve({ name, input, preview: `Edit ${input.path}` })) {
					return { content: 'User rejected edit_file.', isError: true };
				}
				return await editFile(input.path, input.old_string, input.new_string);
			}
			case 'list_dir': return await listDir(input.path ?? '.');
			case 'grep': return await grep(input.pattern, input.glob);
			case 'run_terminal': {
				if (!await approve({ name, input, preview: `Run: ${input.command}` })) {
					return { content: 'User rejected run_terminal.', isError: true };
				}
				return await runTerminal(input.command, input.cwd);
			}
			default: return { content: `Unknown tool: ${name}`, isError: true };
		}
	} catch (e: any) {
		return { content: String(e?.message ?? e), isError: true };
	}
}

async function readFile(rel: string): Promise<{ content: string }> {
	const abs = safePath(rel);
	const text = await fs.readFile(abs, 'utf8');
	const lines = text.split('\n').slice(0, 4000);
	return { content: lines.join('\n') };
}

async function writeFile(rel: string, content: string): Promise<{ content: string }> {
	const abs = safePath(rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, 'utf8');
	return { content: `Wrote ${rel} (${content.length} bytes).` };
}

async function editFile(rel: string, oldStr: string, newStr: string): Promise<{ content: string; isError?: boolean }> {
	const abs = safePath(rel);
	const text = await fs.readFile(abs, 'utf8');
	const idx = text.indexOf(oldStr);
	if (idx === -1) { return { content: `old_string not found in ${rel}.`, isError: true }; }
	if (text.indexOf(oldStr, idx + 1) !== -1) {
		return { content: `old_string is not unique in ${rel}.`, isError: true };
	}
	const updated = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
	await fs.writeFile(abs, updated, 'utf8');
	return { content: `Edited ${rel}.` };
}

async function listDir(rel: string): Promise<{ content: string }> {
	const abs = safePath(rel);
	const entries = await fs.readdir(abs, { withFileTypes: true });
	return { content: entries.map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') };
}

async function grep(pattern: string, glob?: string): Promise<{ content: string }> {
	const root = workspaceRoot();
	const re = new RegExp(pattern);
	const hits: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		if (hits.length >= 50) { return; }
		let entries: any[] = [];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (hits.length >= 50) { return; }
			if (e.name === 'node_modules' || e.name === '.git' || e.name === 'out' || e.name === 'dist') { continue; }
			const full = path.join(dir, e.name);
			if (e.isDirectory()) { await walk(full); continue; }
			if (glob && !new RegExp(glob.replace(/\*/g, '.*')).test(full)) { continue; }
			try {
				const txt = await fs.readFile(full, 'utf8');
				const lines = txt.split('\n');
				for (let i = 0; i < lines.length && hits.length < 50; i++) {
					if (re.test(lines[i])) {
						hits.push(`${path.relative(root, full)}:${i + 1}: ${lines[i].slice(0, 200)}`);
					}
				}
			} catch { /* skip binary */ }
		}
	};
	await walk(root);
	return { content: hits.join('\n') || '(no matches)' };
}

async function runTerminal(command: string, cwd?: string): Promise<{ content: string }> {
	const wd = cwd ? safePath(cwd) : workspaceRoot();
	return await new Promise(resolve => {
		cp.exec(command, { cwd: wd, timeout: 60000, maxBuffer: 8192 * 1024 }, (err, stdout, stderr) => {
			const out = (stdout + stderr).slice(0, 8192);
			resolve({ content: err ? `Exit ${err.code}\n${out}` : out || '(no output)' });
		});
	});
}
