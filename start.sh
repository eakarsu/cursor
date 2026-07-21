#!/usr/bin/env bash
# Safe launcher for the independently implemented server and the incomplete
# editor checkout. This script never installs dependencies or kills processes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-auto}"
RUNTIME_PORT="${PORT:-${BACKEND_PORT:-}}"
if [[ $# -gt 0 ]]; then shift; fi

load_server_env() {
	local env_file="$ROOT/server/.env"
	if [[ -f "$env_file" ]]; then
		set -a
		# shellcheck disable=SC1090
		source "$env_file"
		set +a
	fi
}

start_server() {
	if [[ ! -f "$ROOT/server/package.json" ]]; then
		echo "error: server/package.json is missing" >&2
		exit 1
	fi
	if [[ ! -d "$ROOT/server/node_modules" ]]; then
		echo "error: server dependencies are not installed" >&2
		echo "review server/README.md, then install them explicitly before launch" >&2
		exit 1
	fi
	if [[ ! "$RUNTIME_PORT" =~ ^[0-9]+$ ]]; then
		echo "error: PORT or BACKEND_PORT must be an assigned numeric port" >&2
		exit 2
	fi
	if lsof -tiTCP:"$RUNTIME_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
		echo "error: assigned port $RUNTIME_PORT is already in use; no process was stopped" >&2
		exit 1
	fi
	load_server_env
	export PORT="$RUNTIME_PORT"
	export HOST="${HOST:-127.0.0.1}"
	export PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:$RUNTIME_PORT}"
	if [[ "${NODE_ENV:-development}" != production ]]; then
		export ALLOW_LOCAL_PASSWORD_LOGIN="${ALLOW_LOCAL_PASSWORD_LOGIN:-true}"
	fi
	cd "$ROOT/server"
	exec npm run dev -- "$@"
}

start_editor() {
	local nvmrc="$ROOT/vscode/.nvmrc"
	local launcher="$ROOT/vscode/scripts/code.sh"
	local missing=()
	[[ -f "$nvmrc" ]] || missing+=("vscode/.nvmrc")
	[[ -x "$launcher" ]] || missing+=("vscode/scripts/code.sh")
	if (( ${#missing[@]} )); then
		echo "error: editor checkout is incomplete; missing required paths:" >&2
		printf '  - %s\n' "${missing[@]}" >&2
		echo "use './start.sh server' for the available backend, or restore the editor from an authoritative licensed source" >&2
		exit 1
	fi
	if [[ "${ACKNOWLEDGE_UNVERIFIED_SOURCE:-}" != "1" ]]; then
		echo "error: editor provenance/licensing is unresolved" >&2
		echo "review PROVENANCE_REQUIRED.md; set ACKNOWLEDGE_UNVERIFIED_SOURCE=1 only in an isolated local review environment" >&2
		exit 1
	fi

	export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
	if [[ -s "$NVM_DIR/nvm.sh" ]]; then
		# shellcheck disable=SC1091
		source "$NVM_DIR/nvm.sh"
		nvm use --delete-prefix --silent "$(<"$nvmrc")" || nvm use --silent "$(<"$nvmrc")"
	fi
	cd "$ROOT/vscode"
	exec "$launcher" "$@"
}

case "$MODE" in
	auto)
		if [[ -x "$ROOT/vscode/scripts/code.sh" && -f "$ROOT/vscode/.nvmrc" ]]; then
			start_editor "$@"
		else
			start_server "$@"
		fi
		;;
	server) start_server "$@" ;;
	editor) start_editor "$@" ;;
	*)
		echo "usage: ./start.sh [auto|server|editor] [arguments...]" >&2
		exit 2
		;;
esac
