# Task 13: Renaming a tree throws away the question being typed

Priority: **Should fix** (user loses typed text). Source: repo audit, 2026-10-17.

## Now

1. Developer: write the draft to the stash on every change in `useComposer` (`web/src/components/chat/useComposer.ts:83`, `:109-112`). About 20 minutes.
2. Developer: add `draftStash.move(from, to)` and call it on tree rename and anchor move. About 30 minutes.

## Short

- The draft is written to `lib/draft-stash.ts` only in the unmount cleanup.
- The new panel reads the stash during render, before the old panel's cleanup runs.
- Rename the tree title: the id changes, ChatView remounts under `<new>:main`, the draft is stored under `<old>:main`, nobody reads it.
- The same happens to a side-chat draft when its anchor node is renamed or moved.

## Where

- `web/src/components/chat/useComposer.ts:83`, `:109-112`
- `web/src/App.tsx:266` (`key={tree.data.id}`), `:295` (`key={tree}:{anchor}`)
- `web/src/components/sidebar/TreeSettings.tsx:46-52`

## Fix

1. Save to the stash inside `setDraft`/`setFiles`, not only on unmount.
2. `draftStash.move(fromKey, toKey)`.
3. Call it from `onTreeRenamed` (`${from}:main`, `${from}:side:*`) and from `onNodesChanged` (side anchor).

## Done when

A `lib/draft-stash` test covers `move`; manual check: type, rename the tree, the draft is still there.

## Next

Open `web/src/components/chat/useComposer.ts` at line 83.
