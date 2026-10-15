#!/usr/bin/env bash
# Builds the project and starts server + web in the background.
# Usage: ./up.sh [--no-build]
#   server: http://127.0.0.1:3001 (node dist/index.js)
#   web:    http://127.0.0.1:4173 (vite preview, proxies /api to the server)
# Logs and pid files live in .run/. Stop with ./down.sh.
set -euo pipefail

cd "$(dirname "$0")"
RUN_DIR=.run
mkdir -p "$RUN_DIR"

is_running() {
  local pidfile=$1
  [[ -f $pidfile ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

if is_running "$RUN_DIR/server.pid" || is_running "$RUN_DIR/web.pid"; then
  echo "Already running. Run ./down.sh first." >&2
  exit 1
fi

if [[ ! -f server/.env ]]; then
  echo "server/.env is missing (see server/.env.example)." >&2
  exit 1
fi

if [[ ${1:-} != "--no-build" ]]; then
  echo "Building..."
  pnpm build
fi

echo "Starting server..."
nohup pnpm --filter @otago/server start >"$RUN_DIR/server.log" 2>&1 &
echo $! >"$RUN_DIR/server.pid"

echo "Starting web..."
nohup pnpm --filter @otago/web preview >"$RUN_DIR/web.log" 2>&1 &
echo $! >"$RUN_DIR/web.pid"

sleep 2
if ! is_running "$RUN_DIR/server.pid"; then
  echo "Server failed to start, see $RUN_DIR/server.log" >&2
  exit 1
fi
if ! is_running "$RUN_DIR/web.pid"; then
  echo "Web failed to start, see $RUN_DIR/web.log" >&2
  exit 1
fi

echo "Up: web http://127.0.0.1:4173  api http://127.0.0.1:3001"
echo "Logs: $RUN_DIR/server.log, $RUN_DIR/web.log"
