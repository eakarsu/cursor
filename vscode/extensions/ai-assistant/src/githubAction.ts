import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

const WORKFLOW = `name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Compute diff
        id: diff
        run: |
          git diff --unified=3 origin/\${{ github.base_ref }}...HEAD > diff.patch
          BYTES=$(wc -c < diff.patch)
          echo "bytes=$BYTES" >> $GITHUB_OUTPUT
          if [ "$BYTES" -gt 200000 ]; then
            echo "::warning::Diff too large ($BYTES bytes), truncating to 200KB"
            head -c 200000 diff.patch > diff.trimmed
            mv diff.trimmed diff.patch
          fi

      - name: Run Claude review
        id: claude
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          DIFF=$(jq -Rs . < diff.patch)
          BODY=$(cat <<EOF
          {
            "model": "claude-opus-4-7",
            "max_tokens": 2000,
            "system": "You are reviewing a pull request. Be terse. Surface real issues only — bugs, regressions, security, performance. Skip nits and style. Group findings by file.",
            "messages": [{"role":"user","content": "Review this diff:\\n\\n$DIFF"}]
          }
          EOF
          )
          curl -sS https://api.anthropic.com/v1/messages \\
            -H "x-api-key: $ANTHROPIC_API_KEY" \\
            -H "anthropic-version: 2023-06-01" \\
            -H "content-type: application/json" \\
            -d "$BODY" \\
            > resp.json
          jq -r '.content[0].text' resp.json > review.md
          {
            echo 'review<<DELIM'
            cat review.md
            echo DELIM
          } >> $GITHUB_OUTPUT

      - name: Post review comment
        uses: actions/github-script@v7
        with:
          script: |
            const review = \`\${{ steps.claude.outputs.review }}\`;
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: \`### AI review\\n\\n\${review}\`,
            });
`;

export async function installGithubAction(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { vscode.window.showWarningMessage('Open a workspace first.'); return; }

	const dir = path.join(root, '.github', 'workflows');
	const file = path.join(dir, 'ai-pr-review.yml');

	try {
		await fs.access(file);
		const ow = await vscode.window.showWarningMessage('ai-pr-review.yml already exists. Overwrite?', 'Overwrite', 'Cancel');
		if (ow !== 'Overwrite') { return; }
	} catch { /* missing — proceed */ }

	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(file, WORKFLOW, 'utf8');

	const doc = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(doc);

	vscode.window.showInformationMessage(
		'Workflow created. Add ANTHROPIC_API_KEY to your repo secrets, then commit & push.',
		'Open repo secrets',
	).then(c => {
		if (c === 'Open repo secrets') {
			void vscode.env.openExternal(vscode.Uri.parse('https://github.com/settings/secrets/actions'));
		}
	});
}
