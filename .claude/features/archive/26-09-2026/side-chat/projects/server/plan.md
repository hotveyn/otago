# Server plan — side-chat

Project: `server` (Fastify 5 + Zod + Claude Agent SDK, TypeScript). Role: contract owner.
Contract spec: `.claude/features/side-chat/contracts/` (`messages.ts`, `concurrency.ts`, `errors.ts`, `index.ts`).

## Scope

The side chat needs no new endpoint. The server changes are:

1. **Per-tree readers-writer lock.** Message streams take a *shared* lock, so any number can run at once. Move and delete take an *exclusive* lock. Conflicts are rejected with 409 and never queued, which is the default in feature.md.
2. **Machine-readable 409s.** The JSON error body gets an optional `code` field (`tree_busy_streaming` | `tree_busy_structural`). The `error` string stays, so the change is backward compatible.
3. **Collision-free sibling naming.** `createNode` must never pick the same name for two concurrent creations under one parent, and must never overwrite a node.
4. **Staging sweep safety.** When two streams run under the same parent, one stream's `sweepStaleStaging` must never delete the other's live staging folder.

The wire format of `POST /trees/:tree/messages` does not change: same body, same `chunk | attachment | done | error` events.

## Current state (verified)

- `src/agent/lock.ts` `TreeLocks` is a `Set<string>`. `acquire` throws `ConflictError('Tree "<id>" is busy with another request')`. `withLock` wraps it. `isLocked` is used in tests.
- `src/routes/messages.ts` L43 calls `locks.acquire(treeId)` before `readTree`/`readChain`. It releases on a pre-stream error (L62) and in `finally` (L138), after `createNode` and `raw.end` prep.
- `src/routes/nodes.ts` L16 and L29 call `locks.withLock(tree, …)` for delete and move.
- `src/app.ts` error handler sends `{ error }` for `AppError`. `locks` is injectable through `AppDeps.locks`.
- `src/storage/nodes.ts` `createNode` works like this. It writes `node.md` into the staging dir, then loops 5 times over `uniqueName(parentDir, base, reserved)` and `rename(staging, parent/name)`, retrying on `EEXIST`/`ENOTEMPTY`. Within one process, two concurrent calls can both get the same candidate from `uniqueName`, because `readdir` happens before either rename. Correctness currently relies on the OS rejecting the rename with `ENOTEMPTY` onto a non-empty dir. That works on POSIX, but it wastes a retry and depends on `node.md` being present first. An empty same-named dir, which cannot happen through the API, would be silently replaced by `rename`.
- `src/storage/attachments.ts` `sweepStaleStaging(parentDir, 1h)` removes `.tmp-answer-*` dirs whose mtime is more than 1h old. A long stream (over 1h without a new attachment) could be swept by a sibling stream started later.
- Tests: `test/agent.test.ts` (the `TreeLocks` unit test), `test/messages-api.test.ts` ('409 while the tree is locked'), `test/nodes-api.test.ts` ('409 while the tree lock is held', which uses `locks.acquire('rust')`), and `test/storage.test.ts` (createNode suffixes). `test/helpers.ts` `makeApp` does not accept `locks`.

## Files to change

### 1. `server/src/errors.ts`
- `AppError` gets an optional `readonly code?: string` (constructor parameter 3, optional).
- `ConflictError(message: string, code?: ConflictCode)` passes it through.
- Export `type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural'`, matching `contracts/errors.ts`.

### 2. `server/src/app.ts`
- In the error handler for `AppError`, send `{ error: error.message, ...(error.code ? { code: error.code } : {}) }`. Nothing else changes.

### 3. `server/src/agent/lock.ts`: rewrite `TreeLocks` as a readers-writer lock
Keep it in-memory and synchronous, so the check and the set happen in one tick with no race.

```
state: Map<treeId, { shared: number; exclusive: boolean }>   // entry deleted when idle
acquireShared(treeId): () => void      // throws ConflictError(tree_busy_structural) if exclusive
acquireExclusive(treeId): () => void   // throws ConflictError(tree_busy_structural) if exclusive,
                                       //        ConflictError(tree_busy_streaming) if shared > 0
withShared<T>(treeId, fn): Promise<T>
withExclusive<T>(treeId, fn): Promise<T>
status(treeId): { shared: number; exclusive: boolean }  // for tests/diagnostics
isLocked(treeId): boolean              // true if any holder (kept for compatibility)
```
- Release functions are idempotent (a `released` flag). Shared release decrements, exclusive release clears the flag, and the map entry is deleted when both are idle.
- Take the messages verbatim from `contracts/concurrency.ts` `CONFLICT_MESSAGES`, with `<tree>` replaced by the tree id.
- Remove `acquire`/`withLock`. Every caller is updated below, so no alias is needed. Update the doc comment.
- Extension seam (not implemented): an optional per-tree cap on shared holders, and a queueing policy. Leave room by keeping the policy decision inside `acquire*`.

### 4. `server/src/routes/messages.ts`
- L42–43: `const release = locks.acquireShared(treeId);`. Update the comment: "Shared lock before reading, so a move/delete cannot change the chain; other streams may run in parallel."
- Keep the lifetime as it is: release on a pre-stream error, and in `finally` after `createNode`/`listAttachments`. That way a move/delete can never run between the rename and the `done` event.
- No body or event changes.

### 5. `server/src/routes/nodes.ts`
- L16 and L29: `locks.withLock` becomes `locks.withExclusive`.

### 6. `server/src/storage/fs-utils.ts`: in-process name claims
Add `claimUniqueName(dir, base, reserved?): Promise<{ name: string; release: () => void }>`:
- `await readdir(dir)` (missing dir counts as empty). Then, **synchronously in the same continuation**, pick the first `base`, `base-2`, … that is not in `taken`, not in `reserved`, and not in `claims.get(dir)`. Add it to `claims` and return it.
- `claims` is a module-level `Map<string, Set<string>>`, keyed by resolved dir. `release` removes the name and deletes the empty set. It is idempotent.
- Keep `uniqueName` for other callers, or implement it through the same picker.

### 7. `server/src/storage/nodes.ts`: `createNode`
- Replace `uniqueName` in the retry loop with `claimUniqueName(parentDir, base, reserved)`, and call `release()` in a `finally` after the rename attempt. The claim only needs to live until the rename either lands or fails. After success the name is in `readdir`.
- Keep the `EEXIST`/`ENOTEMPTY` retry for other processes and external writers. Raise attempts from 5 to 10.
- No-overwrite guarantee: `node.md` is always written into the source folder (staging dir, or the `createDirAtomic` temp dir) before the rename. POSIX `rename` onto an existing non-empty dir then fails instead of replacing it. Document this invariant in a comment.
- `moveNodes` (L169): switch to `claimUniqueName` too, for consistency. It is exclusive-locked, so this only guards against in-process misuse. Cheap.

### 8. `server/src/storage/attachments.ts`: sweep safety
- Add a module-level `activeStaging = new Set<string>()`. `createAnswerStaging` adds its `dir`.
- Add `release(): void` (idempotent) to `AnswerStaging`: it removes `dir` from `activeStaging`. `discard()` calls it too.
- `src/routes/messages.ts` `finally`: call `staging.release()` unconditionally, after the discard-if-not-committed step. The folder is either renamed into the node or discarded by then.
- `sweepStaleStaging` skips any path in `activeStaging`.

### 9. `server/test/helpers.ts`
- `makeApp(agent, models, extra)`: accept `extra.locks?: TreeLocks`, pass it to `buildApp`, and return `locks` in the context. Create a `new TreeLocks()` when it is not given, so tests can inspect it.

No generated files. The repo has no OpenAPI or other codegen, so there is no regeneration command. The web client mirrors `contracts/` by hand.

## Step order

1. `errors.ts` + `app.ts` (the `code` field). Run the tests; the existing 409 tests still pass.
2. `lock.ts` rewrite + `messages.ts` + `nodes.ts` call sites. Update `test/agent.test.ts` and `test/nodes-api.test.ts` to the new API in the same step.
3. `fs-utils.ts` `claimUniqueName` + `nodes.ts` `createNode`/`moveNodes`.
4. `attachments.ts` active-staging guard.
5. `helpers.ts` + the new tests below.
6. Run `pnpm --filter @otago/server test` and `pnpm --filter @otago/server lint` (biome check + `tsc --noEmit`). Formatting only via `pnpm format`, never by hand.

## Test plan

### `test/agent.test.ts`: replace `describe('TreeLocks')`
- Many shared holders on one tree: `acquireShared('a')` ×3 succeeds, and `status('a').shared === 3`.
- `acquireExclusive('a')` while shared is held throws 409 with `code: 'tree_busy_streaming'`.
- While exclusive is held, `acquireShared('a')` and `acquireExclusive('a')` throw 409 with `code: 'tree_busy_structural'`.
- Per-tree isolation: tree `b` is unaffected.
- Release is idempotent. Calling a shared release twice does not decrement another holder's count. After all releases, `isLocked('a') === false` and exclusive can be taken.
- `withExclusive`/`withShared` release on throw.

### `test/messages-api.test.ts`
- Replace '409 while the tree is locked' with **"two streams in the same tree run concurrently from the same parent"**. Use a gated fake agent with `name: 'test-node'` and start `Q1` and `Q2` from `parentId: ''`. Both return 200 with a `done` event. The `nodeId`s are distinct (`test-node`, `test-node-2`). Each `node.md` has its own `user` text (Q1 and Q2 not swapped). After both finish, `ctx.locks.isLocked('rust') === false`.
- **Concurrent streams from different parents** (main and side, e.g. `a` and `a/b`): both succeed.
- **Move/delete during a stream**: returns 409 `code: 'tree_busy_streaming'`. The same request after the stream returns 200.
- **Stream while exclusive is held**: call `ctx.locks.acquireExclusive('rust')`, then POST a message. It returns 409 `code: 'tree_busy_structural'`, no SSE, and no staging dir is left. After release, 200.
- **One stream aborted, the other completes**: use `listen` + `fetch` + abort on one, as in the existing disconnect test. The other still gets `done`, only its node exists, and the lock is idle afterwards.
- **Parent gone between turns**: POST with a deleted `parentId` returns 404 `Node not found: …` (verify the existing behaviour, which covers anchor deleted/moved).
- The existing tests ('lock untouched' on 400, runner error releases the lock, disconnect releases the lock) keep passing and now assert `locks.status('rust')` is idle.

### `test/nodes-api.test.ts`
- Update '409 while the tree lock is held': `locks.acquireShared('rust')` makes delete/move return 409 `tree_busy_streaming` with `body.code` asserted. With `acquireExclusive`, they return 409 `tree_busy_structural`. After release, 200.

### `test/storage.test.ts`
- **Concurrent createNode, same parent, same name**: `Promise.all` of 5 `createNode(treeDir, '', 'ownership', node(..., 'Qn'))` gives 5 distinct ids (`ownership`, `ownership-2` … `ownership-5`). Every `node.md` parses and has its own `user`, and nothing is overwritten.
- The same with `stagingDir` (create 3 staging dirs via `createAnswerStaging` and commit them concurrently). All attachments stay in their own node.
- `claimUniqueName` unit test: two claims without release get different names, and after release the name can be claimed again.

### `test/attachments.test.ts`
- `sweepStaleStaging` with `maxAgeMs = 0` does not remove an active staging dir, and does remove an inactive (discarded-from-set but still on disk) one.

## Risks / notes
- Locks are per process. Running several server processes on one trees dir is not supported (unchanged). Cross-process creation is still protected by the rename retry.
- Two streams from the same parent can both call `sweepStaleStaging(parentDir)` at the same time. `rm` uses `force` and errors are ignored, so this is safe.
- Two concurrent streams double the load on the Agent SDK. No cap is added. It is a seam in `acquireShared`.
