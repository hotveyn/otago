#!/usr/bin/env bash
# Stops the server and web processes started by ./up.sh.
set -uo pipefail

cd "$(dirname "$0")"
RUN_DIR=.run

stop() {
  local name=$1 pidfile=$RUN_DIR/$1.pid
  if [[ ! -f $pidfile ]]; then
    echo "$name: not running (no pid file)"
    return
  fi
  local pid
  pid=$(cat "$pidfile")
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name: not running (stale pid $pid)"
    rm -f "$pidfile"
    return
  fi
  # pnpm spawns node as a child: stop the whole process group.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$name: did not exit in 10 s, killing"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  fi
  rm -f "$pidfile"
  echo "$name: stopped (pid $pid)"
}

stop server
stop web

# Leftovers if pid files were lost (e.g. after a reboot or a manual start).
pkill -f "node dist/index.js" 2>/dev/null && echo "server: killed leftover process"
pkill -f "vite preview" 2>/dev/null && echo "web: killed leftover process"
exit 0
