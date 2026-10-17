# Task 10: Moving or deleting several nodes can stop halfway

Priority: **Should fix** (partial writes on error). Source: repo audit, 2026-10-17.

## Now

1. Developer: add rollback to `deleteNodes` and `moveNodes` (`server/src/storage/nodes.ts:197-211`, `:345-361`). About 30 minutes.
2. Developer: add one test where the second rename fails. About 20 minutes.

## Short

- Each node folder is renamed in turn.
- If the second rename throws (EACCES, EBUSY, ENAMETOOLONG with `.deleted-<ts>`), the first node has already moved.
- The route returns 500, so `questions.remap`/`dropUnder` never run and the web records no undo.
- The trash id of the already-deleted node is never returned.
- `restoreNodes` already rolls back (`:406-411`), with no test.

## Where

- `server/src/storage/nodes.ts:197-211` (`deleteNodes`)
- `server/src/storage/nodes.ts:345-361` (`moveNodes`)
- `server/src/storage/nodes.ts:406-411` (`restoreNodes` rollback to copy)
- Callers: `server/src/routes/nodes.ts:28-29`, `:52-53`

## Fix

Copy the restore pattern: keep `done[]`, and in `catch` rename each done entry back in reverse order, then rethrow.

## Done when

With `rename` mocked to fail on the second call, both functions leave the tree exactly as before. Add the same test for `restoreNodes`.

## Next

Open `server/src/storage/nodes.ts` at line 406 and read the rollback loop.
