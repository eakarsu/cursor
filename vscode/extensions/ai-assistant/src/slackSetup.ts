import * as vscode from 'vscode';

export async function slackSetup(): Promise<void> {
	const learnMore = 'Learn how to create a Slack app';
	const next = await vscode.window.showInformationMessage(
		'This will configure a Slack MCP server. You need a Slack bot token (xoxb-…) and your Team ID.',
		'Continue', learnMore, 'Cancel',
	);
	if (next === learnMore) {
		await vscode.env.openExternal(vscode.Uri.parse('https://api.slack.com/authentication/token-types#bot'));
		return;
	}
	if (next !== 'Continue') { return; }

	const token = await vscode.window.showInputBox({
		prompt: 'Slack bot token',
		placeHolder: 'xoxb-…',
		password: true,
		ignoreFocusOut: true,
		validateInput: v => v && !v.startsWith('xoxb-') ? 'Should start with xoxb-' : undefined,
	});
	if (!token) { return; }

	const teamId = await vscode.window.showInputBox({
		prompt: 'Slack Team ID (Workspace Settings → About this Workspace)',
		placeHolder: 'T01ABCDEFGH',
		ignoreFocusOut: true,
		validateInput: v => v && !/^T[A-Z0-9]+$/.test(v) ? 'Team IDs start with T' : undefined,
	});
	if (!teamId) { return; }

	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const servers = { ...(cfg.get<Record<string, any>>('mcp.servers') ?? {}) };
	servers.slack = {
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-slack'],
		env: { SLACK_BOT_TOKEN: token, SLACK_TEAM_ID: teamId },
	};
	await cfg.update('mcp.servers', servers, vscode.ConfigurationTarget.Global);

	await vscode.commands.executeCommand('aiAssistant.connectMcp');
	vscode.window.showInformationMessage('Slack MCP configured. Try asking the agent to post to #general.');
}
