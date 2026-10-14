# tree-undo — server plan (`@otago/server`)

Contract (source of truth): `.claude/features/tree-undo/contracts/`
- `trash.ts` — deleted-folder naming, `DELETED_NAME_RE`, `TrashId`.
- `nodes-api.ts` — delete (soft, returns `deleted`), move (optional `names`), new restore.
- `errors.ts` — error body, 404 codes, status policy for undo.
- `history.ts` — web-owned history entry union + id remap rule (reference for the web plan).

No codegen exists for this API (Zod route schemas, no OpenAPI step), so nothing is regenerated.

## Resolved open questions

1. **Deleted suffix format:** `<name>.deleted-<epochMs>` (`-<n>` appended only if that exact
   name already exists). The `.` makes it a non-slug, so it can never come from `toKebabCase`,
   never collides with a live sibling, and is already skipped by `readHierarchy` (`isSlug`
   filter) and rejected by `nodeIdSegments`. Purge can find trash by `DELETED_NAME_RE` alone.
2. **Purge policy:** none in v1. Trash accumulates. No startup sweep. `DELETED_NAME_RE` +
   the timestamp are the seam for a later TTL/manual purge.
3. **Agent visibility:** hide, layered, with a documented residual risk:
   - (a) pass inline SDK `settings: { permissions: { deny: ['Read(**/*.deleted-*/**)'] } }` in
     `buildAskOptions` (Claude Code applies Read deny rules to Read and, as ignore patterns, to
     Grep/Glob);
   - (b) a `PreToolUse` hook (`hooks` option) on `Read|Grep|Glob` that denies calls whose
     `file_path` / `path` / `pattern` / `glob` touches a segment matching `.deleted-` —
     deterministic and unit-testable without the SDK;
   - (c) one line in `SYSTEM_RULES` (`agent/prompt.ts`): "Ignore folders whose name contains
     `.deleted-`; they are deleted nodes."
   - Implement-stage verification (manual, real SDK, via `pnpm --filter @otago/server ask`):
     a tree with a soft-deleted node containing a unique word; confirm Grep without `path` does
     not return it. If (a) does not filter Grep/Glob output in this SDK version, fall back to
     writing a `.ignore` file (`*.deleted-*/`) in the tree root on first soft delete (ripgrep
     honours `.ignore`; `.ignore` is a non-slug so never a node). If neither works, keep (b)+(c)
     and record the residual risk (unscoped Grep may print matches from trash) in README.
4. **History model:** open discriminated union keyed by `type` (`contracts/history.ts`); all
   id-changing responses expose `old → new` maps with prefix-rewrite semantics so a future
   `rename-node` / `rename-tree` entry plugs in without changing move/delete entries.

## Data model changes (filesystem)

- Delete no longer `rm`s. It renames `parent/<name>` → `parent/<name>.deleted-<epochMs>` in
  the same parent folder (single atomic `fs.rename`, never crosses devices).
- Subtree stays inside the trash folder unchanged. Moving/deleting an ancestor carries it along;
  its TrashId changes by the same prefix rewrite as node ids.
- No migration: existing trees have no trash folders.
- Visibility audit (no code change needed, but covered by tests): `readHierarchy`,
  `readChain`, `nodeExists`, `validateSelection`, `claimUniqueName` (trash name never equals a
  slug candidate), `sweepStaleStaging` (only touches `.tmp-answer-*`), `listAttachments` /
  `listUserFiles` (only their own subfolders).

## Files to change / create

### `server/src/storage/paths.ts` (change)
- Add `DELETED_MARKER = '.deleted-'`, `DELETED_NAME_RE` (exact regex from `contracts/trash.ts`).
- Add `isDeletedName(name)`, `deletedNameFor(name, now = Date.now())`.
- Add `parseTrashId(trashId): ParsedTrashId` — split on last `/`; parent part through
  `nodeIdSegments` (throws `InvalidInputError`), last segment must match `DELETED_NAME_RE`
  (else `InvalidInputError('Invalid trash id: …')`); rejects `\`, absolute paths.
- Add `trashDirOf(treeDir, trashId)` using `resolveInside`.

### `server/src/errors.ts` (change)
- `NotFoundError` gets optional second arg `code?: NotFoundCode`
  (`'node_not_found' | 'parent_not_found' | 'trash_not_found' | 'tree_not_found'`).
  Existing callers compile unchanged; add codes where touched (`assertNodeExists` →
  `node_not_found`; target/parent checks → `parent_not_found`; `existingTreeDir` →
  `tree_not_found`). Update the existing "error bodies without a code omit the field" test if
  it relies on a 404 without code (keep one path that has no code, e.g. a 400).

### `server/src/storage/nodes.ts` (change)
- `deleteNodes(treeDir, ids, now?)` → returns `Record<NodeId, TrashId>`. For each top-level id:
  `rename(nodeDir, join(parentDir, deletedNameFor(name, now)))`; on `EEXIST`/`ENOTEMPTY` retry
  with `-2`, `-3` suffix (max 10). Note: the target never exists as a non-empty folder under
  normal use, but `rename` onto an existing EMPTY dir succeeds on POSIX — check `exists()` first
  and pick the next counter, then rename.
- `moveNodes(treeDir, ids, targetParentId, names?)`: when `names[id]` is given, use it as the
  claim base instead of the current basename. Validate each name: `isSlug`, not in
  `reservedNamesFor(targetParentId)`, key must be in `ids` → else `InvalidInputError`.
  Target missing → `NotFoundError(…, 'parent_not_found')`.
- New `restoreNodes(treeDir, trashIds): Promise<Record<TrashId, NodeId>>`:
  1. dedupe; reject nested (one TrashId prefix of another, using `isSameOrDescendant`) → 400;
  2. validate all: `parseTrashId`; parent live (`nodeExists`) else 404 `parent_not_found`;
     trash dir contains `node.md` else 404 `trash_not_found`;
  3. for each, `claimUniqueName(parentDir, originalName, reservedNamesFor(parentId))` +
     `rename(trashDir, join(parentDir, name))`, release claim in `finally`;
  4. on a mid-way failure, rename already restored folders back to their trash names (best
     effort) and rethrow.
- Extract a small internal helper `renameClaimed(fromDir, parentDir, base, reserved)` used by
  `moveNodes` and `restoreNodes` (and reusable by rename-trees-nodes, see Overlaps).

### `server/src/routes/nodes.ts` (change)
- Delete: `return { deleted, nodes }`.
- Move: body gains `names: z.record(nodeId, z.string().max(200)).optional()`; pass through.
- New `POST /trees/:tree/nodes/restore`, body `z.object({ trashIds: z.array(z.string().max(1000)).min(1).max(1000) })`,
  `existingTreeDir` → `locks.withExclusive(tree, …)` → `{ restored, nodes: readHierarchy(dir) }`.

### `server/src/agent/claude-agent.ts` (change)
- `buildAskOptions`: add `settings` with the Read deny rule and `hooks.PreToolUse` with
  matcher `Read|Grep|Glob` → `denyDeletedPaths` hook.

### `server/src/agent/trash-guard.ts` (create)
- Pure `touchesDeletedPath(toolName, input): boolean` + `createTrashGuardHook()` returning the
  SDK hook callback (`permissionDecision: 'deny'`, reason "Deleted nodes are not available").
  Imports `DELETED_MARKER` from `storage/paths.ts`.

### `server/src/agent/prompt.ts` (change)
- One rule line in `SYSTEM_RULES` about ignoring `*.deleted-*` folders.

### `server/src/storage/trees.ts` (change, minor)
- `existingTreeDir` 404 gets `tree_not_found` code.

### Docs (change)
- `README.md`: node management now soft-deletes; trash folders `*.deleted-*` accumulate and can
  be removed by hand; residual agent-visibility note if applicable.
- `CLAUDE.md` Architecture/storage bullet: one line on soft-deleted folders and the restore route.
  (`docs/design.md` referenced by README does not exist in the repo — nothing to update there.)

## Step order

1. `paths.ts` constants + `parseTrashId` + unit tests.
2. `errors.ts` optional 404 code; wire codes into `assertNodeExists` / `existingTreeDir`.
3. `deleteNodes` soft delete + returned map; route returns `deleted`. Update existing delete
   tests (folder now renamed, not removed).
4. `moveNodes` `names` option + route schema.
5. `restoreNodes` + route.
6. Agent guard (`trash-guard.ts`, `buildAskOptions`, prompt line) + tests; manual SDK check.
7. Docs. Run `pnpm check` then `pnpm lint` and `pnpm test` (never hand-format).

## Test plan

`server/test/storage.test.ts`
- `deletedNameFor` / `isDeletedName` / `DELETED_NAME_RE`: round-trip, rejects slugs, `-2` form.
- `parseTrashId`: root and nested; rejects `../x.deleted-1`, missing marker, non-slug parent,
  reserved parent (`sources/…`), backslashes.
- `readHierarchy` ignores a folder `foo.deleted-1759000000000/node.md` at root and nested.
- `readChain`/`nodeExists` on a trash path → 400 (invalid id), not a leak.
- `createNode` with the same slug as a trashed sibling gets the plain name (no `-2`).

`server/test/nodes-api.test.ts`
- Delete: response `deleted` maps top-level ids to TrashIds; folder exists on disk under trash
  name with subtree intact; hierarchy no longer lists it; nested selection yields one entry.
- Delete same name twice at the same `now` (inject via storage-level test) → `-2` counter.
- Restore: round-trip returns original id and hierarchy equals the pre-delete one (incl.
  descendants and `node.md` content).
- Restore when a sibling took the name → `<name>-2`, returned in `restored`.
- Restore with parent gone → 404 `parent_not_found`, nothing renamed.
- Restore unknown / already restored TrashId → 404 `trash_not_found`; batch with one bad id →
  none restored.
- Restore malformed TrashId → 400; nested TrashIds → 400.
- Delete a parent that contains a trashed child, restore parent, then restore child with the
  parent-prefixed TrashId → works (LIFO scenario).
- Move with `names`: move-back after a `-2` forward move restores the original name; name taken
  → `-2`; invalid slug / reserved name / key not in `ids` → 400.
- Move to missing parent → 404 `parent_not_found`.
- Restore takes the exclusive lock: 409 `tree_busy_streaming` while a gated stream holds shared;
  409 `tree_busy_structural` while exclusive is held.

`server/test/agent.test.ts`
- `touchesDeletedPath`: Read `file_path` inside trash → true; Grep `path`/`glob`, Glob
  `pattern`/`path` containing `.deleted-` → true; normal paths → false.
- `buildAskOptions` includes the deny rule in `settings.permissions.deny` and a `PreToolUse`
  matcher for `Read|Grep|Glob`; hook callback returns `deny` for a trash path.
- System prompt contains the trash rule line.

## Overlaps with `rename-trees-nodes` (in progress, server stage pending)

- Both edit `storage/nodes.ts`, `routes/nodes.ts`, `errors.ts`; land sequentially and share
  `renameClaimed` (claim unique name + rename, release in finally).
- Both return `old → new` id maps with the same prefix-rewrite semantics (`moved`, `restored`,
  `renamed`); rename's map is directly usable by undo remapping, TrashIds included.
- The `names` option on move overlaps conceptually with node rename. Keep it: undo-move needs
  "move back AND take the original name" in one exclusive-locked request. Same-parent renames
  stay with the rename feature (`names` is ignored for nodes already under the target).
- Tree rename changes the tree id and the lock key; TrashIds are tree-relative so they survive.
  The web history (keyed by tree id in sessionStorage) must be re-keyed by the web plan.
- Rename validation/uniqueness automatically ignores trash folders (non-slug names).
- `tree_busy_structural` message says "moved or deleted"; if rename rewords it, restore is
  covered too — coordinate a single wording change, no new code.
- Future `rename-node` undo = rename back to `oldName`; collision falls back to `-2` and the
  returned map fixes the stack, same as restore.
