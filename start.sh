#!/usr/bin/env bash
# Launch the AI Code dev build with secrets sourced from server/.env.
# Usage: ./start.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT/server/.env"

if [[ -f "$ENV_FILE" ]]; then
	# Export every KEY=VALUE line that's not a comment.
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
else
	echo "warning: $ENV_FILE not found — running without env vars" >&2
fi

# nvm: switch to the Node version pinned by vscode/.nvmrc
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
	# shellcheck disable=SC1091
	source "$NVM_DIR/nvm.sh"
	nvm use --delete-prefix --silent "$(cat "$ROOT/vscode/.nvmrc")" || nvm use --silent "$(cat "$ROOT/vscode/.nvmrc")"
fi

cd "$ROOT/vscode"
exec ./scripts/code.sh "$@"
