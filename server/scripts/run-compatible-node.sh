#!/usr/bin/env bash
set -euo pipefail

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
declare -a candidates=()

add_candidate() {
	local candidate="${1:-}"
	[[ -n "$candidate" && -x "$candidate" ]] || return 0
	local existing
	for existing in "${candidates[@]:-}"; do
		[[ "$existing" != "$candidate" ]] || return 0
	done
	candidates+=("$candidate")
}

add_candidate "${CURSOR_NODE_BIN:-}"
add_candidate "$(command -v node 2>/dev/null || true)"
add_candidate /opt/homebrew/bin/node
add_candidate "${NVM_BIN:-}/node"
add_candidate /Users/erolakarsu/.nvm/versions/node/v22.22.1/bin/node

for candidate in "${candidates[@]}"; do
	if (cd "$server_dir" && "$candidate" -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()") >/dev/null 2>&1; then
		exec "$candidate" "$@"
	fi
done

echo "No Node.js runtime can load the installed better-sqlite3 binding" >&2
exit 69
