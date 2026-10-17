# Task 7: A move or delete that finishes after a tree switch lands in the new tree

Priority: **Must fix** (wrong data shown, wrong undo). Source: repo audit, 2026-10-17.

## Now

1. Developer: pass `treeId` in the variables of each graph mutation (`web/src/components/graph/GraphView.tsx:471-515`). About 30 minutes.
2. Developer: in each `onSuccess`, bail out to a cache-only update when `vars.treeId` is not the live tree. About 15 minutes.

## Short

- `<GraphView>` has no `key`, so the same instance lives across tree switches (`web/src/App.tsx:240`).
- TanStack Query 5 gives a pending mutation the newest options, so `onSuccess` runs with tree B's `tree.id`, `currentId` and `undo`.
- Delete in tree A, click tree B before the reply: A's hierarchy is written into B's cache.
- A's undo entry goes onto B's stack; a later Ctrl+Z in B may change B's nodes.
- B's in-flight questions are dropped or remapped with A's node ids.

## Where

- `web/src/components/graph/GraphView.tsx:471-515` (move, delete, rename mutations)
- `web/src/App.tsx:240` (`<GraphView>` without `key`)

## Fix

In each `onSuccess(result, vars)`: if `vars.treeId !== live.current.treeId`, call `applyHierarchy(result.nodes, vars.treeId)` and return. Do not record undo or call `onNodesChanged` for the old tree.

Smaller alternative: `key={tree.id}` on `<GraphView>`. It loses the result of a pending mutation entirely, so the cache-only update above is safer.

## Done when

A test (or manual run with a slowed server) shows: delete in A, switch to B, B's graph and undo stack unchanged; A shows the delete when reopened.

## Next

Open `web/src/components/graph/GraphView.tsx` at line 471.
