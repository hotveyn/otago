# tree-undo — web plan (`@otago/web`)

Contract (read-only, plan strictly against it): `.claude/features/tree-undo/contracts/`
- `nodes-api.ts` — delete now returns `deleted: Record<NodeId, TrashId>`; move accepts optional
  `names`; new `POST /api/trees/:tree/nodes/restore` → `{ restored, nodes }`.
- `history.ts` — `HistoryEntry` open union (`move`, `delete`) + prefix-rewrite remap rule.
- `trash.ts` — `TrashId` = tree-relative path of the trash folder (`<liveParent>/<name>.deleted-<ms>`).
- `errors.ts` — `{ error, code?, details? }`; 404 codes; status policy 400/404 → drop, 409 → keep.

No codegen exists for this API (hand-written `web/src/api/types.ts`, no OpenAPI step), so
nothing is regenerated. Types below are hand-mirrored into `api/types.ts` during implement, as
is done today for other features.

## Design decisions

1. **Where things live.** Pure history logic (entry model, (de)serialization, remap, record,
   step planning, executor with injected API, error policy) in `web/src/lib/undo-history.ts`.
   Keyboard predicates in `web/src/lib/keyboard.ts`. A thin React hook
   `web/src/components/graph/useTreeUndo.ts` (precedent: `components/chat/useChatSession.ts`)
   owns the per-tree stack state, the in-flight ref, the keydown listener and toast state.
   `GraphView` records forward actions and applies results using its existing
   `applyHierarchy` / `onCurrentChange` / `onNodesChanged` paths. Vitest runs in the node
   environment (no jsdom), so everything testable is pure or takes injected deps.
2. **Id remapping — trash is just another prefix rewrite.** Every id-changing event is an
   `old → new` map applied with the contract rule to every `NodeId` / `TrashId` in the stack
   (`currentId`, `oldParentId`, `trashId`, `originalId`):
   - forward move: `moved` (old → new);
   - forward delete: `deleted` (originalId → TrashId). Ids of older entries that pointed into
     the deleted subtree become paths inside the trash folder (`P.deleted-1/…`). They are
     unusable until the delete is undone, which (LIFO) always happens first; the restore map
     (`TrashId → newId`) rewrites them back to live ids. Nested trash (child deleted, then its
     parent) works the same way: `P/c.deleted-1` → `P.deleted-2/c.deleted-1` → `P/c.deleted-1`.
   - undo-move: the `moved` response; undo-delete: the `restored` response.
   - future `renamed` map (rename-trees-nodes) plugs into the same function.
   The new entry being recorded is pushed AFTER remapping the older ones (its ids are already
   post-action).
3. **Undo of a move = one move request per old parent**, with `names: { [currentId]: oldName }`
   so a `-2` forward rename is reverted. Groups run sequentially; after each successful group
   the whole stack is remapped by the response and the finished items are removed from the top
   entry. A failure mid-entry leaves only the unfinished items (keep on 409, drop on 400/404).
4. **Undo of a delete = one restore request** with all `trashIds` of the entry (server validates
   all before renaming anything, so it is all-or-nothing).
5. **Error policy** (`errors.ts` `UndoStatusPolicy`): 400 → drop, 404 → drop (codes only refine
   the toast text), 409 → keep. Anything else (network error, 5xx) → keep (retryable). Toast
   in every failure case; the rest of the stack is always kept.
6. **Toast** = the existing `.graph-error` slot in `GraphView` (`ErrorNote` with dismiss),
   auto-dismissed after ~6 s. No new toast system. Successful undo is silent (graph animates;
   `MOVE_MS` glide already exists). Empty stack → no request, no toast.
7. **Persistence.** `sessionStorage` key `otago:undo:v1:<treeId>` holding
   `{ v: 1, entries: HistoryEntry[] }` (oldest first). Written after every change; read on
   tree switch/mount. Invalid JSON / wrong version / malformed entries are dropped silently.
   Cap `HISTORY_CAP = 50`, oldest dropped (trash folders are not purged — server does nothing).
   Seam for tree rename: `renameHistoryKey(storage, oldTreeId, newTreeId)` (tiny, exported,
   used later by rename-trees-nodes; TrashIds are tree-relative so entries survive unchanged).
8. **Open union.** Per-type codecs `ENTRY_CODECS: { [T in HistoryEntry['type']]: (raw) => entry | null }`
   and per-type `planNextStep` / `completeStep` switch with an exhaustive `never` check. A new
   `rename-node` member = new interface + codec + step kind; move/delete untouched. Entries keep
   their own inverse data (self-describing) so redo would not need a redesign (not built).

## Files to create / change

### `web/src/api/types.ts` (change)
- Add `TrashId = string`, `DeleteResult { deleted: Record<string, TrashId>; nodes: HierarchyNode[] }`,
  `RestoreResult { restored: Record<TrashId, string>; nodes: HierarchyNode[] }`.
- Add `NotFoundCode = 'node_not_found' | 'parent_not_found' | 'trash_not_found' | 'tree_not_found'`
  (comment: mirrors `.claude/features/tree-undo/contracts/errors.ts`).
- `ErrorBody.code` union gains `NotFoundCode`.
- `MoveResult` unchanged.

### `web/src/api/client.ts` (change)
- `ApiError.code` type gains `NotFoundCode`; add a `NOT_FOUND_CODES` list and include it in
  `isErrorCode`.
- `deleteNodes(id, ids)` → returns the full `DeleteResult` (was `nodes` only); defensive
  `deleted: r.deleted ?? {}` for an older server (then no history entry is recorded).
- `moveNodes(id, ids, targetParentId, names?)` → body `{ ids, targetParentId, names }`; `names`
  omitted from JSON when undefined (existing callers unchanged).
- New `restoreNodes(id, trashIds)` → `POST ${tree(id)}/nodes/restore` body `{ trashIds }` →
  `RestoreResult`.

### `web/src/lib/storage.ts` (change)
- Add `safeSession` twin of `safeStorage` over `window.sessionStorage` (never throws).
- Export a minimal `KeyValueStore { get(key): string | null; set(key, value | null): void }`
  type both satisfy, so history code takes an injected store (tests use an in-memory map).

### `web/src/lib/undo-history.ts` (create) — pure
- Types mirroring `contracts/history.ts`: `HistoryEntryBase<T>`, `MoveHistoryEntry`,
  `DeleteHistoryEntry`, `HistoryEntry` union; `HISTORY_CAP = 50`; `historyKey(treeId)`.
- `loadHistory(store, treeId): HistoryEntry[]` / `saveHistory(store, treeId, entries)` (empty →
  remove key) / `renameHistoryKey(store, from, to)`.
- `remapId(id, map)` — contract rule (`x === old || x.startsWith(old + '/')` →
  `new + x.slice(old.length)`; identity pairs and `''` keys ignored).
- `remapEntry(entry, map)` / `remapHistory(entries, map)` — per-type switch, returns the same
  array when nothing changed.
- `recordMove(entries, moved, now, newId)` — remap older entries by `moved`, then push a move
  entry from non-identity pairs: `{ currentId: new, oldParentId: parentIdOf(old), oldName: nameOf(old) }`
  (helpers from `lib/tree.ts`); no entry if all pairs are identity; cap.
- `recordDelete(entries, deleted, now, newId)` — remap older entries by `deleted`, push
  `{ items: [{ trashId, originalId }] }` (skip if empty); cap. `now`/`newId` injected
  (hook passes `new Date().toISOString()` and `crypto.randomUUID()`).
- `UndoStep` union: `{ kind: 'move'; items: number[]; ids; targetParentId; names }` |
  `{ kind: 'restore'; items: number[]; trashIds }` — `items` = indexes of the entry items the
  step covers.
- `nextStep(entry): UndoStep | null` — move: first group by `oldParentId` (insertion order);
  delete: all items in one restore.
- `completeStep(entry, step): HistoryEntry | null` — drop covered items; `null` when none left.
- `idMapOf(step, response)` — move → `response.moved`; restore → `response.restored`.
- `restoredAsMoves(entry, restored)` — `originalId → restoredId` pairs (non-identity only) for
  URL/side-chat fixups (same shape as a move map, so `afterMove` / `remapSideAfterMove` apply).
- `classifyUndoError(error): { drop: boolean; message: string }` — policy from decision 5;
  message: 409 via existing `describeError` texts; 404 by code → `graph:undo.parentMissing` /
  `trashMissing` / `nodeMissing` / `treeMissing`, fallback `graph:undo.stale`; 400 →
  `graph:undo.invalid`; other → `graph:undo.failed` + server message.
- `runUndo(entries, api, onStep?)` — the executor, deps injected:
  `api = { move(ids, target, names): Promise<MoveResult>; restore(trashIds): Promise<RestoreResult> }`.
  Takes the top entry; loops `nextStep` → call → on success `remapHistory(all, idMap)` then
  replace top with `completeStep`; calls `onStep({ nodes, fixups })` after each success so the
  UI applies hierarchy/URL even if a later step fails. On failure: `classifyUndoError`; drop →
  pop top entry, keep → leave the (partially completed) entry. Returns
  `{ entries, error?: { message, dropped } }`. Empty stack → returns immediately, no call.

### `web/src/lib/keyboard.ts` (create) — pure
- `isUndoShortcut(e)`: `(e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z'`
  (both modifiers accepted on every OS; Shift excluded so a future redo can claim it).
- `isEditableTarget(target)`: structural check (no DOM types needed in tests) — `INPUT` (any
  type except `checkbox|radio|button|submit|reset|range|color|file`), `TEXTAREA`, `SELECT`, or
  `isContentEditable`; also true if `closest('[contenteditable=""],[contenteditable="true"]')`
  matches.
- `shouldHandleTreeUndo(e)`: `isUndoShortcut && !e.repeat && !e.defaultPrevented &&
  !e.isComposing && !isEditableTarget(e.target)`.

### `web/src/components/graph/useTreeUndo.ts` (create) — thin hook
- `useTreeUndo({ treeId, blocked, onApplied })` where `blocked` = streaming busy, a dialog open,
  or a forward move/delete pending; `onApplied(treeId, { nodes, fixups })`.
- State: `entries` (loaded from `safeSession` when `treeId` changes; saved on every change),
  `pending`, `toast` (message + auto-dismiss timer, cleared on tree switch).
- `inFlight` ref: set before the first request, cleared in `finally`; Ctrl/Cmd+Z while set →
  `preventDefault()` and ignore (no parallel requests).
- `window` keydown listener: `shouldHandleTreeUndo(e)` → `preventDefault()`; if `blocked` for
  streaming → toast `errors.busyStreaming` locally without a request, entry kept (server 409 still
  covers other tabs); if dialog open / forward action pending → ignore; if stack empty → nothing.
- Captures `treeId` at start of an undo; results are written to that tree's storage key and
  `onApplied` receives it, so a tree switch mid-request cannot leak into the new tree.
- Exposes `{ recordMove(moved), recordDelete(deleted), pending, toast, dismissToast, canUndo }`.

### `web/src/components/graph/GraphView.tsx` (change)
- Instantiate `useTreeUndo`. `blocked` = `busy || dialog !== null || remove.isPending || move.isPending`.
- `remove.onSuccess(result)`: `applyHierarchy(result.nodes)`, then existing flow, plus
  `undo.recordDelete(result.deleted)`.
- `move.onSuccess(result)`: existing flow plus `undo.recordMove(result.moved)`.
- `onApplied(capturedTreeId, { nodes, fixups })`: write hierarchy into `keys.tree(capturedTreeId)`
  and remove its chain queries (generalise `applyHierarchy` to take a tree id); only if
  `capturedTreeId === tree.id`: `animateTo` handled by the existing layout effect,
  `onCurrentChange(afterMove(currentId, fixups))` and `onNodesChanged({ kind: 'move', moved: fixups })`
  when `fixups` is non-empty. (Undo-move: fixups = `moved`; undo-delete: `restoredAsMoves`.)
  Current node is not navigated to restored nodes.
- Disable Delete / Move-to buttons and dragging while `undo.pending` (avoid a self-inflicted
  `tree_busy_structural`).
- Render `undo.toast` in the `.graph-error` slot (prefer the forward-action error when both).
- Toolbar hint text mentions the shortcut.

### `web/src/App.tsx` (no change expected)
- `onNodesChanged` already remaps the side chat for `move` maps; restore fixups reuse it.
  `remapSideAfterDelete` keeps a deleted anchor, so a restore to the same id revives the panel
  once chain queries refetch.

### `web/src/lib/chat-errors.ts` (small change)
- None required for the 409 texts (reused). `isNodeMissing` keeps its message-prefix check; add
  `|| error.code === 'node_not_found'` so side chat also recognises the coded 404.

### i18n (change) — `web/src/i18n/locales/{en,ru}/graph.ts`
- New `undo` group: `stale`, `nodeMissing`, `parentMissing` ("Can't undo: the original parent
  no longer exists."), `trashMissing` ("Can't undo: the deleted node is gone from the trash."),
  `treeMissing`, `invalid`, `failed` ("Undo failed: {{message}}"), plus `hint` update
  ("… · Ctrl/⌘+Z to undo").
- `delete.body_*`/`bodyNested_*`: drop "permanently … Git is the only backup"; say the nodes
  are removed and can be restored with Ctrl/⌘+Z (both locales; ru keys must match en — the
  locale type enforces parity).

## Step order

1. `api/types.ts` + `api/client.ts` (delete result, move `names`, `restoreNodes`, codes) + tests.
   Adjust `GraphView` to `result.nodes` so the build stays green.
2. `lib/storage.ts` `safeSession` + `KeyValueStore`.
3. `lib/undo-history.ts` (model, codecs, remap, record, steps, error policy, `runUndo`) + tests.
4. `lib/keyboard.ts` + tests.
5. `components/graph/useTreeUndo.ts`, wire into `GraphView` (record, apply, toast, disable).
6. i18n strings (en + ru), `isNodeMissing` code check.
7. `pnpm check`, then `pnpm lint` and `pnpm test` (never hand-format). Manual run with
   `pnpm dev` against the server branch (scenarios below).

## Test plan

`web/src/lib/undo-history.test.ts` (in-memory `KeyValueStore`, fake api with `vi.fn`)
- `remapId`: exact match, descendant prefix, non-match with shared string prefix
  (`a` vs `ab`), identity pair ignored, TrashId with rewritten parent prefix.
- `recordMove`: identity pairs omitted; all-identity → no entry; oldParentId/oldName derived
  (`a/b` → parent `a`, name `b`; root-level → `''`); older entries remapped (their `currentId`,
  `oldParentId`, `trashId`, `originalId`), new entry not double-remapped.
- `recordDelete`: items from `deleted`; older move entry whose node lay in the deleted subtree
  is rewritten into the trash path; empty `deleted` (old server) → no entry.
- Cap: 51st push drops the oldest; order preserved.
- `load/save`: round-trip; per-tree keys isolated; invalid JSON, wrong `v`, unknown `type`,
  malformed item → dropped; empty stack removes the key; `renameHistoryKey` moves the value.
- `nextStep`/`completeStep`: move items with two old parents → two steps with `names`; delete →
  one restore step with all trashIds; completion removes covered items → `null` at the end.
- `runUndo` scenarios:
  - empty stack → no api call;
  - undo move → `move(ids, oldParent, { [currentId]: oldName })`; entry popped; `onStep`
    fixups = `moved`;
  - undo move back gets `-2` (name taken) → remaining older entries remapped to the `-2` id;
  - undo delete → `restore(trashIds)`; fixups = originalId → restoredId (only if different);
  - LIFO chain: move A under P, delete P, undo, undo → second undo moves the (restored) A back
    with correct ids; child-then-parent delete, undo twice → both restored via rewritten TrashIds;
  - two-group move, second group 409 → first group applied and removed, entry kept with the
    remaining item, error `dropped: false`;
  - 404 `parent_not_found` / `trash_not_found` / `node_not_found` → entry dropped, rest kept,
    message per code; 400 → dropped; 409 `tree_busy_streaming` / `tree_busy_structural` → kept;
    network `TypeError` / 500 → kept.
- `classifyUndoError`: policy table + messages (English via `test-setup.ts`).

`web/src/lib/keyboard.test.ts`
- Ctrl+Z and Meta+Z → true; with Shift / Alt / plain `z` / repeat / defaultPrevented /
  composing → false; uppercase `Z` (caps lock) → true.
- Editable: textarea, text input, select, contenteditable element and a child of one → true;
  checkbox input, button, div → false.

`web/src/api/client.test.ts` (existing `mockFetch` helper)
- `restoreNodes` posts `{ trashIds }` to `/api/trees/<enc>/nodes/restore` and returns the body.
- `moveNodes` with `names` includes it; without — body has no `names` key.
- `deleteNodes` returns `{ deleted, nodes }`; missing `deleted` → `{}`.
- 404 with `code: 'parent_not_found'` → `ApiError.code` set; unknown code → undefined.

`web/src/lib/chat-errors.test.ts`
- `isNodeMissing` true for `ApiError(404, …, 'node_not_found')`.

Manual (with the server implementation, `pnpm dev`)
- Move 2 nodes, Ctrl+Z → back under old parents, URL `node=` follows; reload tab → stack
  survives; new tab → empty stack.
- Forward move produced `-2`; undo restores the original folder name.
- Delete a subtree containing the current node and the side-chat anchor; Ctrl+Z → restored,
  side panel works again.
- Ctrl+Z in composer / tree settings inputs → native text undo only, no request.
- Ctrl+Z during streaming → busy toast, entry kept; retry after stream → works.
- Hold Ctrl+Z / press rapidly → one request at a time.
- Rename a restored node's slot meanwhile (create same-name sibling via chat) → restore
  yields `-2`, URL/stack fixed.
- Delete parent in another tab after a move here → undo → "original parent" toast, entry dropped,
  next Ctrl+Z undoes the previous entry.
- Switch trees → each tree has its own stack.

## Overlaps / seams

- **rename-trees-nodes** (web stage pending): a node rename should call `recordRename` (new
  `rename-node` entry: `{ currentId, oldName }`) and `remapHistory(entries, renamed)`; a tree
  rename calls `renameHistoryKey(safeSession, old, new)`. Both edit `GraphView`/`client.ts`;
  land sequentially.
- **Redo**: excluded; Shift+Ctrl/Cmd+Z is deliberately not matched. Entries are self-describing.
- **Trash UI / purge**: nothing in web; dropped entries never trigger server calls.
