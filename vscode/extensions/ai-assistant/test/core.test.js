// Unit tests for pure logic modules in the AI Assistant extension.
// Run with: node --test test/core.test.js  (after `tsc -p .`)
const stub = require('./vscodeStub');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Now that the stub is registered, we can require compiled extension modules.
const { chunkBySyntax } = require('../out/syntaxChunker');
const { cosine } = require('../out/embeddings');

test('cosine: identical vectors -> 1', () => {
	const v = [1, 2, 3, 4];
	assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
});

test('cosine: orthogonal vectors -> 0', () => {
	assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-6);
});

test('cosine: opposite vectors -> -1', () => {
	assert.ok(Math.abs(cosine([1, 2], [-1, -2]) - -1) < 1e-6);
});

test('chunkBySyntax: typescript splits at function/class anchors', () => {
	const src = [
		'// header',
		'',
		'export function alpha() {',
		'  return 1;',
		'}',
		'',
		'export class Beta {',
		'  m() { return 2; }',
		'}',
		'',
		'function gamma() { return 3; }',
	].join('\n');
	const chunks = chunkBySyntax(src, 'typescript');
	assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
	assert.ok(chunks.some(c => /alpha|Beta|gamma/.test(c.text)));
});

test('chunkBySyntax: unknown language falls back to fixed-size', () => {
	const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
	const chunks = chunkBySyntax(lines, 'klingon');
	assert.ok(chunks.length >= 2);
	for (const c of chunks) {
		assert.ok(c.endLine >= c.startLine);
	}
});

test('chunkBySyntax: python anchors on def/class', () => {
	const src = [
		'import os',
		'',
		'def alpha():',
		'    return 1',
		'',
		'class Beta:',
		'    def m(self):',
		'        return 2',
	].join('\n');
	const chunks = chunkBySyntax(src, 'python');
	assert.ok(chunks.length >= 2);
});

// MENTION_RE is not exported, so we re-derive the same regex contract.
test('mention regex captures supported kinds', () => {
	const RE = /@(file|symbol|docs|git|web|selection):([^\s]+)/g;
	const text = 'do this for @file:src/a.ts and @symbol:Foo also @git:status not @bogus:x';
	const hits = [...text.matchAll(RE)].map(m => m[1] + ':' + m[2]);
	assert.deepEqual(hits, ['file:src/a.ts', 'symbol:Foo', 'git:status']);
});

// Tools sandbox: safePath is internal to tools.ts. We exercise it through write_file via runTool.
test('tools.runTool write_file refuses paths escaping workspace', async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-'));
	stub.__setWorkspace(tmp);
	const { runTool } = require('../out/tools');
	const approved = async () => true;
	const r = await runTool('write_file', { path: '../escape.txt', content: 'x' }, approved);
	assert.equal(r.isError, true, 'expected escape attempt to be rejected');
	assert.match(r.content, /escapes workspace|ENOENT|Path escapes/i);
});

test('tools.runTool write_file + read_file + edit_file roundtrip', async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-'));
	stub.__setWorkspace(tmp);
	const { runTool } = require('../out/tools');
	const approved = async () => true;

	const w = await runTool('write_file', { path: 'a/b.txt', content: 'hello world' }, approved);
	assert.ok(!w.isError, w.content);

	const r = await runTool('read_file', { path: 'a/b.txt' }, approved);
	assert.equal(r.content.trim(), 'hello world');

	const e = await runTool('edit_file', { path: 'a/b.txt', old_string: 'hello', new_string: 'hi' }, approved);
	assert.ok(!e.isError, e.content);

	const r2 = await runTool('read_file', { path: 'a/b.txt' }, approved);
	assert.equal(r2.content.trim(), 'hi world');
});

test('tools.runTool edit_file fails on non-unique old_string', async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-'));
	stub.__setWorkspace(tmp);
	const { runTool } = require('../out/tools');
	const approved = async () => true;
	await runTool('write_file', { path: 'x.txt', content: 'cat cat cat' }, approved);
	const e = await runTool('edit_file', { path: 'x.txt', old_string: 'cat', new_string: 'dog' }, approved);
	assert.equal(e.isError, true);
	assert.match(e.content, /not unique/i);
});

test('tools.runTool requires approval for write_file', async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-'));
	stub.__setWorkspace(tmp);
	const { runTool } = require('../out/tools');
	let asked = false;
	const denied = async () => { asked = true; return false; };
	const r = await runTool('write_file', { path: 'x.txt', content: 'x' }, denied);
	assert.ok(asked);
	assert.equal(r.isError, true);
	assert.match(r.content, /rejected/);
});
