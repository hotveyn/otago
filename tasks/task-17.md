# Task 17: Delete code nothing uses

Priority: **Should fix** (lean). Source: repo audit, 2026-10-17. Each item was grepped across server, web, demo and tests.

## Now

1. Developer: delete the server items below, then run `pnpm test` and `pnpm lint`. About 45 minutes.
2. Developer: delete the web items below. About 15 minutes.

## Short

- About 150 lines that must be read and kept working for nothing.
- The `?tree=` stream filter also returns wrong results after a tree rename.
- Some items are used only by their own tests: delete the tests too.

## Server: unused

- `uniqueName` (`server/src/storage/fs-utils.ts:60-73`)
- `ATTACHMENT_CSP` (`server/src/routes/attachments.ts:18`)
- `export { MAX_SOURCE_BYTES }` re-export (`server/src/app.ts:24`)
- the trash-inside-trash check that can't fail (`server/src/storage/nodes.ts:376-382`; `parseTrashId` already rejects it)
- second `existingTreeDir` call after `readTree` (`server/src/routes/trees.ts:27-28`)

## Server: used only by tests or never by the web

- `TreeLocks.status`, `isLocked`, `withShared` (`server/src/agent/lock.ts:46-55`, `:94-101`)
- `AttachmentStaging.saveFromStream` and the `'sandbox'` origin (`server/src/storage/attachments.ts:16`, `:243-247`, `:367-373`; mirror in `web/src/api/types.ts:52`)
- the `?tree=` filter on `/questions/events`: `Subscriber.tree`, `treeOf`, `list(tree)`, `treeFilter` (`server/src/questions/registry.ts:450-455`, `server/src/routes/questions.ts:37`, `:170-173`, `:179`) and its tests. This changes the contract in `.claude/features/`.

## Web

- `finishedNodeIdOf` (`web/src/lib/blockers.ts:52-57`) and its test
- `isRunningStatus` (`web/src/lib/questions.ts:987-988`)
- `ROOT_ID` (`web/src/lib/tree.ts:3`)
- `formatSize` (`web/src/components/sidebar/SourcesPanel.tsx:13-17`): use `formatBytes` from `lib/attachments.ts`

## Duplicates and config

- Fence regexes in `server/src/agent/prompt.ts:147-148`: import `FENCE_OPEN_RE`/`FENCE_CLOSE_RE` from `storage/suggestion-block.ts`.
- `server/tsconfig.json:15` includes a missing `vitest.config.ts`.
- Root `typescript` devDependency (`package.json:22`) looks unused; check your editor does not rely on it first.

## Next

Open `server/src/storage/fs-utils.ts` at line 60.
