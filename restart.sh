#!/usr/bin/env bash
# Restarts the running otago processes so they pick up a fresh build.
# Runs automatically after `pnpm build` (root `postbuild`). Does nothing if the
# project is not running. Supports pm2, launchd and ./up.sh in that order.
set -uo pipefail

cd "$(dirname "$0")"

if command -v pm2 >/dev/null 2>&1 && pm2 describe otago-server >/dev/null 2>&1; then
  pm2 restart otago-server otago-web --silent
  echo "restart: pm2 processes restarted"
  exit 0
fi

if launchctl print "gui/$UID/com.otago.server" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$UID/com.otago.server"
  launchctl kickstart -k "gui/$UID/com.otago.web" 2>/dev/null
  echo "restart: launchd agents restarted"
  exit 0
fi

if [[ -f .run/server.pid ]] && kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
  ./down.sh && ./up.sh --no-build
  exit $?
fi

echo "restart: project is not running, nothing to restart"
