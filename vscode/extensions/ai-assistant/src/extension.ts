import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';
import { AgentViewProvider } from './agentView';
import { ComposerViewProvider } from './composerView';
import { ClaudeInlineCompletionProvider } from './inlineCompletions';
import { call } from './anthropic';
import { CodebaseIndex } from './codebaseIndex';
import { cmdK } from './cmdK';
import { editRules, editMemory } from './rules';
import { registerTabPrediction, acceptTabPrediction } from './tabPredict';
import { registerBackground } from './background';
import { registerBugFinder } from './bugFinder';
import { registerNotepads } from './notepads';
import { multiCursorEdit } from './multiCursorEdit';
import { setCodebaseResolver, setPastChatsResolver } from './mentions';
import * as pastChats from './pastChats';
import * as whisper from './whisper';
import * as onboarding from './onboarding';
import { editIgnore } from './ignoreEditor';
import { screenshotToComponent } from './screenshotToComponent';
import { showBilling } from './billing';
import { slackSetup } from './slackSetup';
import { installGithubAction } from './githubAction';
import { triggerCloudAgent } from './cloudAgents';
import { terminalCmdK } from './terminalCmdK';
import { applyFromClipboard } from './applyFromClipboard';
import { registerSettingsView } from './settingsView';
import { reviewPr } from './prReview';
import { backgroundAgents } from './backgroundAgents';
import { predictMultiFile } from './multiFilePredict';
import { shadowApplyCommand } from './shadowWorkspace';
import * as mcp from './mcp';
import { Auth } from './auth';
import { CloudSync } from './sync';
import { telemetry } from './telemetry';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	telemetry.configure();
	const auth = new Auth(context);
	void auth.restore().catch(() => undefined);
	const sync = new CloudSync(auth);

	const index = new CodebaseIndex();
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.text = '$(sparkle) AI: indexing...';
	statusBar.tooltip = 'Click to reindex workspace';
	statusBar.command = 'aiAssistant.indexWorkspace';
	statusBar.show();
	context.subscriptions.push(statusBar);
	const updateStatus = (): void => {
		if (!index.isReady) { statusBar.text = '$(sparkle) AI: indexing...'; return; }
		const emb = index.embeddingsReady ? '✓' : 'BM25';
		statusBar.text = `$(sparkle) AI: ${index.fileCount}f · ${index.chunkCount}c · ${emb}`;
		statusBar.tooltip = `Codebase index ready · ${index.fileCount} files · ${index.chunkCount} chunks · ${index.embeddingsReady ? 'embeddings on' : 'BM25 only'}\nClick to reindex`;
	};
	void index.build().then(updateStatus).catch(e => { telemetry.error('index.build', e); statusBar.text = '$(sparkle) AI: index failed'; });
	setCodebaseResolver(async (q) => { await index.ensureBuilt(); return index.formatContext(q, 12); });
	pastChats.init(context);
	whisper.init(context);
	setPastChatsResolver(async (q) => pastChats.searchPastChats(q, 5));
	onboarding.maybeShow(context);

	// Pull memory on activation if signed in
	void sync.pullMemory().catch(() => undefined);

	const chatProvider = new ChatViewProvider(context.extensionUri, index);
	const agentProvider = new AgentViewProvider(context.extensionUri, index);
	const composerProvider = new ComposerViewProvider(context.extensionUri, index);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
		vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, agentProvider),
		vscode.window.registerWebviewViewProvider(ComposerViewProvider.viewType, composerProvider),
	);

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ scheme: 'file' },
			new ClaudeInlineCompletionProvider()
		)
	);

	registerTabPrediction(context);
	registerBackground(context, index);
	registerBugFinder(context);
	registerNotepads(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.multiCursorEdit', () => multiCursorEdit()),
		vscode.commands.registerCommand('aiAssistant.terminalCmdK', () => terminalCmdK()),
		vscode.commands.registerCommand('aiAssistant.applyFromClipboard', () => applyFromClipboard()),
		vscode.commands.registerCommand('aiAssistant.reviewPr', () => reviewPr()),
		vscode.commands.registerCommand('aiAssistant.runBackgroundAgent', () => backgroundAgents.runFromInput(index)),
		vscode.commands.registerCommand('aiAssistant.showBackgroundAgents', () => backgroundAgents.showPanel()),
		vscode.commands.registerCommand('aiAssistant.predictCrossFile', () => predictMultiFile(index)),
		vscode.commands.registerCommand('aiAssistant.shadowApply', () => shadowApplyCommand()),
		vscode.commands.registerCommand('aiAssistant.editIgnore', () => editIgnore()),
		vscode.commands.registerCommand('aiAssistant.screenshotToComponent', () => screenshotToComponent()),
		vscode.commands.registerCommand('aiAssistant.showBilling', () => showBilling(auth)),
		vscode.commands.registerCommand('aiAssistant.slackSetup', () => slackSetup()),
		vscode.commands.registerCommand('aiAssistant.installGithubAction', () => installGithubAction()),
		vscode.commands.registerCommand('aiAssistant.runCloudAgent', () => triggerCloudAgent(auth)),
	);
	registerSettingsView(context);

	// File watcher to incrementally invalidate the index on big changes
	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	let rebuildTimer: NodeJS.Timeout | undefined;
	const scheduleRebuild = (): void => {
		if (rebuildTimer) { clearTimeout(rebuildTimer); }
		rebuildTimer = setTimeout(() => { void index.build().then(updateStatus); }, 5000);
	};
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(scheduleRebuild),
		watcher.onDidChange(scheduleRebuild),
		watcher.onDidDelete(scheduleRebuild),
	);

	// MCP
	void mcp.connectAll().catch(e => vscode.window.showWarningMessage('MCP: ' + e.message));
	context.subscriptions.push({ dispose: () => mcp.disconnectAll() });

	// Push memory when .aicode/* changes
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (/\.aicode\/(memory|rules)\.md$/.test(doc.uri.fsPath.replace(/\\/g, '/'))) {
				void sync.pushMemory();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('aiAssistant.telemetryEndpoint')) { telemetry.configure(); }
		}),
	);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.openChat', () => {
			vscode.commands.executeCommand('workbench.view.extension.ai-assistant');
			chatProvider.reveal();
		}),
		vscode.commands.registerCommand('aiAssistant.openAgent', () => {
			vscode.commands.executeCommand('workbench.view.extension.ai-assistant');
			agentProvider.reveal();
		}),
		vscode.commands.registerCommand('aiAssistant.openComposer', () => {
			vscode.commands.executeCommand('workbench.view.extension.ai-assistant');
			composerProvider.reveal();
		}),
		vscode.commands.registerCommand('aiAssistant.cmdK', () => cmdK()),
		vscode.commands.registerCommand('aiAssistant.editRules', () => editRules()),
		vscode.commands.registerCommand('aiAssistant.editMemory', () => editMemory()),
		vscode.commands.registerCommand('aiAssistant.indexWorkspace', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: 'AI: indexing...' },
				() => index.build()
			);
			vscode.window.showInformationMessage('AI: workspace indexed.');
		}),
		vscode.commands.registerCommand('aiAssistant.acceptTabPrediction', async () => {
			const ok = await acceptTabPrediction();
			if (!ok) { await vscode.commands.executeCommand('tab'); }
		}),
		vscode.commands.registerCommand('aiAssistant.connectMcp', () => mcp.connectAll()),
		vscode.commands.registerCommand('aiAssistant.showWelcome', () => onboarding.show(context)),
		vscode.commands.registerCommand('aiAssistant.signIn', async () => {
			const s = await auth.signIn();
			if (s) { telemetry.track('auth.signIn', { plan: s.plan }); void sync.pullMemory(); }
		}),
		vscode.commands.registerCommand('aiAssistant.signOut', async () => {
			await auth.signOut();
			telemetry.track('auth.signOut');
			vscode.window.showInformationMessage('Signed out.');
		}),
		vscode.commands.registerCommand('aiAssistant.syncMemoryPush', () => sync.pushMemory()),
		vscode.commands.registerCommand('aiAssistant.syncMemoryPull', () => sync.pullMemory()),
		vscode.commands.registerCommand('aiAssistant.explainSelection', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return; }
			const sel = editor.document.getText(editor.selection);
			if (!sel.trim()) { vscode.window.showInformationMessage('Select some code first.'); return; }
			const lang = editor.document.languageId;
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'AI: explaining...' },
				async () => {
					try {
						const r = await call({
							system: 'Explain code clearly and concisely. 3-6 sentences max.',
							messages: [{ role: 'user', content: `Explain this ${lang} code:\n\n\`\`\`${lang}\n${sel}\n\`\`\`` }],
							maxTokens: 600,
							task: 'chat',
						});
						const doc = await vscode.workspace.openTextDocument({ content: r.text, language: 'markdown' });
						await vscode.window.showTextDocument(doc, { preview: true });
					} catch (e: any) {
						telemetry.error('explainSelection', e);
						vscode.window.showErrorMessage(`AI: ${e?.message ?? e}`);
					}
				}
			);
		}),
	);
}

export function deactivate(): void { /* mcp disposed via subscriptions */ }
