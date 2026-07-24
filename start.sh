#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for env_file in "$project_dir/.env" "$project_dir/server/.env"; do
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done
export API_PORT="${API_PORT:-${BACKEND_PORT:-}}"
export UI_PORT="${UI_PORT:-${FRONTEND_PORT:-}}"

required() { [[ -n "${!1:-}" ]] || { echo "$1 is required" >&2; exit 1; }; }
configuration() {
  for key in DB_PATH JWT_SECRET API_PORT UI_PORT OPENROUTER_API_KEY OPENROUTER_MODEL OPENROUTER_BASE_URL ADMIN_EMAIL ADMIN_PASSWORD; do required "$key"; done
  [[ ${#JWT_SECRET} -ge 32 ]] || { echo 'JWT_SECRET must contain at least 32 characters' >&2; exit 1; }
  [[ "$API_PORT" != "$UI_PORT" ]] || { echo 'API_PORT and UI_PORT must differ' >&2; exit 1; }
}
start_services() {
  npm --prefix "$project_dir/server" run create-admin
  (cd "$project_dir/server" && PORT="$API_PORT" HOST=127.0.0.1 PUBLIC_URL="http://127.0.0.1:$UI_PORT" ALLOW_LOCAL_PASSWORD_LOGIN=true ./scripts/run-compatible-node.sh --enable-source-maps dist/index.js) &
  server_pid=$!
  API_PORT="$API_PORT" UI_PORT="$UI_PORT" node "$project_dir/server/scripts/runtime-proxy.mjs" &
  proxy_pid=$!
  wait "$server_pid" "$proxy_pid"
}

case "${1:-start}" in
  check) npm --prefix "$project_dir/server" test && npm --prefix "$project_dir/server" run build ;;
  start|server|auto) configuration; start_services ;;
  *) echo 'usage: ./start.sh [check|start]' >&2; exit 2 ;;
esac
