# Tree undo (Ctrl+Z)

## Summary
Add Ctrl+Z (Cmd+Z on macOS) to the tree web UI. Each press undoes the most recent structural tree edit by sending the inverse request to the backend. The undo history is kept on the frontend (sessionStorage, per tree). Node deletion becomes soft: the node folder is renamed with a "deleted" suffix so it can be restored.

## Goals
- Undo **move nodes**: move them back to their previous parent(s).
- Undo **delete nodes**: restore the soft-deleted folders to their original names/places.
- Frontend-owned history stack per tree, persisted in `sessionStorage` (survives reload within the tab).
- Server: soft delete ("virtual trash") via folder rename + a restore endpoint.

## Non-goals
- Redo (Ctrl+Shift+Z / Ctrl+Y) — not needed.
- Undo of new messages (node creation), tree title/instructions edits, source upload/delete.
- Server-side history storage.
- A trash UI (listing / emptying deleted nodes).

## Actors
- **User** of the local web app, editing the tree graph.
- **Server** (`@otago/server`) performing file-system operations.

## Main scenarios
1. **Undo move.** User moves nodes A, B under P → history push `{type: move, mapping old→new ids, old parents}`. Ctrl+Z → frontend calls move for each new id back to its old parent → graph/URL updated via existing `afterMove`. Entry popped.
2. **Undo delete.** User deletes nodes → server renames each folder `<name>` → `<name><deleted-suffix>` (in place) and returns identifiers needed to restore → history push. Ctrl+Z → frontend calls restore → server renames back (claiming a unique name if the original is taken) → returns new hierarchy + resulting ids.
3. **Empty history.** Ctrl+Z does nothing (no request).

## Edge cases
- **Soft-deleted folders are invisible**: `readHierarchy`, chain reads, node lookups, sibling-name uniqueness, and move/delete validation must ignore folders with the deleted suffix even though they still contain `node.md`. The deleted suffix must not be producible by normal slug naming (no collision with real node names).
- **Agent visibility**: agent `cwd` is the tree folder with Grep/Glob/Read — soft-deleted nodes must not leak into agent context (exclude them or document the risk).
- **Name taken on restore / move back**: original name now used by a sibling → claim a unique name (`-2` suffix), return actual new ids; frontend fixes up remaining history entries and URL.
- **Original parent gone** (e.g. parent deleted after the move/delete): undo fails with a clear error; entry is dropped; toast shown.
- **Stale history** (tree changed in another tab / by CLI, node no longer exists): server returns 404/409 → toast, drop the entry, keep the rest of the stack.
- **Id changes cascade**: a move changes ids of the node and its subtree; older history entries referencing those ids must be remapped (or keyed so that remapping is possible).
- **Lock conflicts**: undo requests take the exclusive tree lock like move/delete; a 409 (stream in progress) → toast, entry stays on the stack so the user can retry.
- **Rapid presses**: while an undo request is in flight, further Ctrl+Z presses are ignored (no parallel undo requests).
- **Focus**: Ctrl+Z inside text inputs/textareas/contenteditable keeps native text undo; tree undo fires only when focus is not in an editable element.
- **Tree switch**: each tree has its own stack; switching trees does not undo across trees.
- **History cap**: stack is bounded (e.g. 50 entries); oldest dropped. Dropping an entry does not purge its trash folder.
- **Backward compatibility**: existing trees have no deleted folders; nothing to migrate.

## Constraints (NFR)
- Filesystem stays the source of truth; renames are atomic (existing `fs-utils` helpers).
- Errors via `AppError` subclasses and existing `{ error, code?, details? }` shape.
- Pure history logic in `web/src/lib/*.ts` with colocated tests; components stay thin.
- Server tests use `fakeAgent`/temp dirs; no real SDK calls.

## Future considerations (out of scope)
- **Rename nodes** (being built as a separate feature): must be addable as a new undoable action type — history entry model must be an open discriminated union, not hard-wired to move/delete.
- **Redo**: explicitly not needed, but keep entries self-describing (inverse data) so it would not require redesign.
- **Trash purge / trash UI**: soft-deleted folders accumulate; a later purge (TTL, on start, manual) must be able to find them by suffix alone.
- Undo for message creation, tree edits, sources — later action types.

## Open questions
- Exact deleted suffix format (e.g. `<name>.deleted-<timestamp>`?) — must be non-slug so it can never clash with a node name; planner to propose.
- Purge policy for soft-deleted folders: none for now (accumulate) — confirm.
- Should soft-deleted nodes be hidden from the agent's Grep/Glob, or is that acceptable for v1?
