// Minimal stub for require('vscode') so we can unit-test pure logic modules.
// Only the surface we actually touch in tested code paths is implemented.
const Module = require('module');
const path = require('path');

const stub = {
	workspace: {
		workspaceFolders: undefined,
		getConfiguration() { return { get: () => undefined }; },
	},
	commands: {
		executeCommand: async () => undefined,
	},
	window: {
		activeTextEditor: undefined,
		showInformationMessage() { },
		showErrorMessage() { },
		showWarningMessage() { },
	},
	env: {
		openExternal: async () => true,
	},
	languages: {
		getDiagnostics: () => [],
	},
	Uri: {
		file: (p) => ({ fsPath: p, toString: () => p }),
		parse: (s) => ({ toString: () => s }),
	},
	Range: function (s, e) { this.start = s; this.end = e; },
	Position: function (l, c) { this.line = l; this.character = c; },
	SymbolKind: {},
	DiagnosticSeverity: {},
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
	if (request === 'vscode') { return path.join(__dirname, 'vscode-virtual.js'); }
	return origResolve.call(this, request, parent, ...rest);
};

require.cache[path.join(__dirname, 'vscode-virtual.js')] = {
	id: path.join(__dirname, 'vscode-virtual.js'),
	filename: path.join(__dirname, 'vscode-virtual.js'),
	loaded: true,
	exports: stub,
};

module.exports = stub;

// Optional helper: configure a fake workspace root for tools tests.
module.exports.__setWorkspace = (root) => {
	stub.workspace.workspaceFolders = root ? [{ uri: { fsPath: root }, name: path.basename(root) }] : undefined;
};
