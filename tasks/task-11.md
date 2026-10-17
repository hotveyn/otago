# Task 11: One broken node.md makes the whole tree fail to open

Priority: **Should fix**. Source: repo audit, 2026-10-17.

## Now

1. Developer: skip unparsable nodes in `liveChildEntries` (`server/src/storage/nodes.ts:58-82`). About 15 minutes.
2. Developer: add one test with a broken `node.md`. About 10 minutes.

## Short

- `liveChildEntries` calls `readNodeFileIfExists` (`:415-424`), which rethrows parse errors.
- One hand-edited node with a missing marker or a broken `created:` makes `GET /api/trees/:tree` return 500.
- Every structural route returns the hierarchy, so they all fail too; the tree can't be opened.
- The code already tolerates a broken `suggestions:` line (`format.ts:69-81`) and a bad `tree.md` (`trees.ts:18`).

## Where

- `server/src/storage/nodes.ts:76`
- `server/src/storage/nodes.ts:415-424`

## Fix

Wrap the read: on an error without an errno `code` (a parse error), log a warning and `continue`. The folder stays in `readdir`, so its name still counts as taken.

## Done when

A tree with one broken `node.md` returns 200 from `GET /api/trees/:tree` without that node.

## Next

Open `server/src/storage/nodes.ts` at line 76.
