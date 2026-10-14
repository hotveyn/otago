# parallel-questions — server plan (`@otago/server`)

Contract (source of truth, server-owned): `.claude/features/parallel-questions/contracts/`
- `questions.ts` — `QuestionInfo` (union by status), `QuestionDetail` (+ `live`), context, failure codes.
- `questions-api.ts` — `POST /api/trees/:tree/questions` (202), `GET /api/questions[?tree]`,
  `GET /api/questions/:id`, `DELETE /api/questions/:id`, `POST /api/questions/:id/retry`;
  removal of `POST /messages`; effects on structural routes.
- `question-events.ts` — `GET /api/questions/events`: framing, `snapshot`/`question`/`chunk`/
  `attachment`/`removed`, ordering guarantees.
- `errors.ts` — new codes, 409 `tree_busy_streaming` `details`, status tables.
- `lifecycle.ts` — state machine, lock, retention, remap, held files, agent isolation, shutdown.
- `naming.ts` — naming after the answer (excerpt, prompt, fallback).
- `node-names.ts` — Unicode node-name rules, `nameKey`, NFC, `DELETED_NAME_RE`.

No codegen exists (Zod route schemas, no OpenAPI step): nothing is regenerated. The web mirrors
the contract by hand. No new dependencies (hand-rolled SSE helper, no `@fastify/sse`).

Formatting: never hand-format. After each step run `pnpm check` (Biome auto-fix) or
`pnpm format`, then `pnpm lint` and the server tests.

## Resolved open questions (feature.md) and client requests

1. **API shape** → start returns an id (`202 { question }`), one app-wide multiplexed SSE stream
   (`snapshot` on connect, then deltas), tree-less per-question routes. No per-question attach
   stream, no polling (HTTP/1.1 6-connection pool through the Vite proxy). `POST /messages` is
   deleted in lockstep with the web (no adapter).
2. **Retention** → cancelled: removed at once; done: text dropped at commit, summary kept 30 min
   (cap 50/tree, then `removed{expired}`); failed: until DELETE/retry, 24 h TTL, cap 50/tree
   (`removed{evicted}`). Clients cannot delete done entries (multi-tab safe).
3. **Follow-up under a pending node** → no. `parentId` must be an existing node.
4. **Unicode slug rules** → `contracts/node-names.ts`: words of `\p{L}\p{Nd}` + `\p{M}` after a
   base, joined by `-`; NFKC → lowercase → NFC; 60 code points / 100 UTF-8 bytes; collisions by
   `nameKey` (APFS fold). Tree ids stay ASCII. Ids are percent-encoded UTF-8 in query strings
   and normalized to NFC by route schemas.
5. **Naming input** → question (≤ 500 graphemes) + cleaned answer excerpt (≤ 1500 chars), after
   the answer, 30 s timeout, fallback from the question.
6. **Uploads** → validated/staged before registration; a rejected or aborted upload never
   creates an entry. Failed questions keep their files outside `trees/` (holding folder).
7. **Client requests** → `live.attachments` (reduced latest-event-per-key) in snapshot/detail;
   `files: UserFileInfo[]` for every status; `error: { message, code }`; `instance` in snapshot;
   409 `details: { questions, preparing }` on EVERY exclusive route (central error handler);
   full-object `question` events; a retry's `question` precedes its chunks; `done` keeps
   `parentId`/`context`/`nodeId`/`attachments`/`files`; tree-less `/api/questions/:id`.
8. **Risks** → per-attempt watchdog (30 min → `failed{timeout}`); PreToolUse guard denies other
   answers' `.tmp-*` folders (+ system rule).

## Data model changes

- **Disk:** none except that node folder names may now contain Unicode letters/marks/digits
  (NFC). Existing names stay valid; nothing is migrated. Failed questions never leave anything
  under `trees/`; their files go to `<os.tmpdir()>/otago-held-XXXX/<questionId>/files`.
- **Memory (new):** question registry (per process), lock holder ids per tree.
- **Agent interface:** `NameInput.answer: string` (new), `AskInput.stagingDir: string` (new).

## Module layout (new)

```
server/src/text.ts                 grapheme helpers (Intl.Segmenter), utf8 length, first line
server/src/storage/node-names.ts   NODE_NAME_RE, isNodeName, toNodeName, nameKey
server/src/storage/held-files.ts   hold / restore / discard files of failed questions; sweep
server/src/questions/types.ts      runtime types mirroring the contract, timings + defaults
server/src/questions/title.ts      questionTitle(text, fileNames)
server/src/questions/registry.ts   QuestionRegistry: pure in-memory state + events + retention
server/src/questions/runner.ts     runAttempt(job, deps): ask → seal → name → commit | fail
server/src/questions/service.ts    Questions: start / retry / remove / blockers / close (facade)
server/src/questions/index.ts      re-exports
server/src/routes/sse.ts           openSse(reply, opts): headers, retry, id/event/data, ping, backpressure
server/src/routes/questions.ts     the six question routes
```

Layering: `registry` has no I/O (no agent, fs, locks) and is unit-tested with fake timers;
`runner` does the async work of one attempt; `service` owns jobs, retry preparation, held files
and lock acquisition for retries, and is the only thing routes talk to (`RouteDeps.questions`).

## Implementation steps (in order; each step leaves the suite green)

### Step 1 — Unicode node names (storage)

`server/src/text.ts` (create)
- Module-level `Intl.Segmenter(undefined, { granularity: 'grapheme' })`.
- `graphemes(s): string[]`, `truncateGraphemes(s, max, ellipsis = '')` (never `slice`),
  `utf8Length(s)`, `firstLine(s)` (first non-empty line, trimmed), `collapseWhitespace(s)`.

`server/src/storage/node-names.ts` (create) — exactly `contracts/node-names.ts`:
- `NODE_NAME_RE`, `NODE_NAME_MAX_CODE_POINTS = 60`, `NODE_NAME_MAX_UTF8_BYTES = 100`.
- `nameKey(s) = s.normalize('NFC').toUpperCase().toLowerCase()`.
- `isNodeName(s)` = regex && NFC-stable && lowercase-stable (no length cap, no reserved check).
- `toNodeName(input, { fallback = 'node', maxWords? })` — algorithm steps 1-7 of the contract;
  final guard: result failing `isNodeName` → `fallback`.

`server/src/storage/paths.ts` (change)
- Rename `isSlug` → `isTreeId`, `toKebabCase` → `toTreeId` (ASCII, tree ids only; doc comment
  says so). Update callers: `treeDirOf`, `storage/trees.ts` (`listTrees`, `createTree`,
  `updateTree`). `SLUG_RE` → `TREE_ID_RE`.
- `isReservedName(parentId, name)` = `reservedNamesFor(parentId).has(nameKey(name))`.
- `nodeIdSegments(id)`: each segment must satisfy `isNodeName` and not be reserved (root
  reserved set for the first segment). NFD input fails here (→ 400); routes normalize first.
- `DELETED_NAME_RE` → Unicode version from the contract. `isDeletedName(name)` additionally
  requires `isNodeName(groups.name)` (the regex alone accepts `A.deleted-…`). `parseTrashId`
  does the same and checks the reserved name by key.

`server/src/storage/fs-utils.ts` (change)
- `takenNames` returns a set of `nameKey`s; `self` removed by key.
- `pickName` tests `nameKey(candidate)` against key sets (reserved names mapped to keys).
- `claims` store keys; `release` deletes the key.
- `UniqueNameOptions` gains `skip?: ReadonlySet<string>` (keys of candidates that already failed
  with `EEXIST`/`ENOTEMPTY` in this call).

`server/src/storage/nodes.ts` (change)
- `readChildren`: `name = entry.name.normalize('NFC')`; skip unless `isNodeName(name)` and not
  reserved; skip a second entry with an already-seen `nameKey` (NFC/NFD twins); read
  `node.md` through the RAW `entry.name`; build ids from the NFC `name`.
- `createNode`: base = `toNodeName(desiredName)`; retry loop keeps a per-call `skip` set and adds
  `nameKey(name)` on `EEXIST`/`ENOTEMPTY`, so the next attempt advances to `-2`, `-3`.
- `renameClaimed`: same `skip` mechanism. `renameNode`: `toNodeName(trimmed)`.
- `moveNodes` `names`: `isNodeName(name) && !isReservedName(targetParentId, name)`.

`server/src/routes/schemas.ts` (change)
- `nodeId = z.string().normalize('NFC').max(1000)`.
- `trashId = z.string().normalize('NFC').max(1000)`; `desiredNodeName =
  z.string().normalize('NFC').max(200)`.
- `routes/nodes.ts`: restore body uses `trashId`; move `names: z.record(nodeId, desiredNodeName)`.
  Verify that Zod 4 applies the key schema's `normalize` to record keys; if not, normalize the
  keys in the handler before calling `moveNodes`.

`server/src/agent/prompt.ts` (change, naming sanitizer only)
- `sanitizeNodeName(raw, fallback = 'node')` = `toNodeName(firstLine(raw), { fallback, maxWords: 4 })`.
- `fallbackNodeName(question)` = `toNodeName(question, { maxWords: 4 })`.

### Step 2 — Naming after the answer

- `server/src/agent/types.ts`: `NameInput.answer: string` (full answer); `Agent.name` doc →
  "2–4 word node name for a question-and-answer exchange, in the answer's language".
- `server/src/agent/prompt.ts`:
  - `NAMING_SYSTEM_PROMPT = 'You name folders. Output only the name.'`
  - `NAMING_PROMPT` rewritten per `contracts/naming.ts` (language rule + labeled examples).
  - `namingExcerpt(answer)` — cleaning rules 1-5 of the contract (`NAMING_EXCERPT_MAX_CHARS`).
  - `buildNamingPrompt({ question, answer })` — `<question>` cut with `truncateGraphemes(…, 500)`,
    `<answer>` = excerpt or `(no prose)`.
- `server/src/agent/claude-agent.ts` `name()`: prompt = `buildNamingPrompt`, system prompt =
  `NAMING_SYSTEM_PROMPT`; everything else unchanged (`maxTurns: 1`, no tools).
- `server/src/routes/messages.ts` (interim; deleted in step 6): move the `agent.name` call after
  the answer with `answer: answer.text` (`.catch(fallbackNodeName)`), so tests stay green.
  Skip this if steps 2 and 6 land together.
- `server/scripts/ask.ts`: call `agent.name` after the answer loop with the final text.
- `server/test/helpers.ts` `fakeAgent`: `name` records the whole `NameInput` (incl. `answer`);
  new options `nameGate?: (input: NameInput) => Promise<void>` (raced with `input.signal`,
  throws on abort) and `nameError?: string`.

### Step 3 — Agent isolation between parallel answers

- `server/src/agent/types.ts`: `AskInput.stagingDir: string` (absolute path of this answer's
  staging folder).
- `server/src/agent/trash-guard.ts` (change; keep the file name):
  - `touchesForeignTemp(toolName, input, ownTempName)` — same tools and keys as
    `touchesDeletedPath`; true when a path segment starts with `TEMP_PREFIX` (`.tmp-`) and is
    not `ownTempName`.
  - `STAGING_DENY_REASON = 'Other answers in progress are not available'`.
  - `createPathGuardHook({ ownTempName })` combines both checks (trash reason first);
    `pathGuardMatcher(ownTempName)` replaces `trashGuardMatcher`. Keep `TRASH_DENY_RULE` (the
    deny rule cannot cover `.tmp-` because the own staging must stay readable).
- `server/src/agent/claude-agent.ts` `buildAskOptions`: `hooks: { PreToolUse:
  [pathGuardMatcher(path.basename(input.stagingDir))] }`.
- `SYSTEM_RULES` gains: "Folders whose name starts with `.tmp-` are other answers being written;
  ignore them, except the files listed for the current question."
- `scripts/ask.ts` passes `stagingDir: staging.dir`.

### Step 4 — Lock holders and `TreeBusyError`

- `server/src/errors.ts`:
  - `NotFoundCode` += `'question_not_found'`.
  - `QuestionConflictCode = 'question_finished' | 'question_not_failed'`; `ConflictError(message,
    code?, details?)` accepts `ConflictCode | QuestionConflictCode`.
  - `class TreeBusyError extends ConflictError` with `readonly treeId: string` and
    `readonly holders: readonly string[]` (snapshot at throw time).
- `server/src/agent/lock.ts`:
  - `acquireShared(treeId, holder?: string)`; per-tree `holders: Map<string, number>` multiset;
    anonymous acquisitions get a unique internal token (`anon:<n>`). `status()` unchanged.
  - `holders(treeId): string[]`.
  - Conflicts throw `TreeBusyError` (messages unchanged). Releasers decrement the holder.
- The `details` mapping is wired in step 6 (it needs the registry).

### Step 5 — Held files (storage)

`server/src/storage/held-files.ts` (create)
- `moveDir(src, dst, renameImpl = fs.rename)`: `rename`; on `EXDEV` → `cp(src, dst,
  { recursive: true })` + `rm(src, { recursive: true })`. Exported for the EXDEV test.
- `createHeldFiles({ root?: string }) → HeldFiles`:
  - `hold(id, stagingDir): Promise<void>` — moves `<staging>/files` → `<root>/<id>/files`
    (no `files/` → no-op). Default root created lazily with `mkdtemp(os.tmpdir() +
    '/otago-held-')` and marked as owned.
  - `restore(id, stagingDir): Promise<void>` — moves `<root>/<id>/files` → `<staging>/files`,
    removes `<root>/<id>`; throws if missing.
  - `discard(id)` — `rm -rf <root>/<id>`, idempotent. `close()` — removes the root if owned.
  - `id` must be a UUID; paths via `resolveInside(root, id)`.
- `sweepHeldRoots({ tmpDir = os.tmpdir(), maxAgeMs = 24 h })` — removes `otago-held-*` folders
  older than `maxAgeMs` (best effort).
- `server/src/storage/user-files.ts`: export `stagedPromptFiles(treeDir, stagingDir):
  Promise<{ files: UserFileInfo[]; prompt: PromptFile[] }>` (`listUserFiles(stagingDir)` +
  the existing private `promptFileOf` with the tree-relative staging `files` folder). Used by
  retry, because the stager only knows files it staged itself.
- `server/src/storage/index.ts`: export `node-names.js`, `held-files.js`.

### Step 6 — Question registry, runner, service, routes (replaces `/messages`)

`server/src/questions/types.ts` (create)
- Runtime mirrors of `QuestionInfo`, `QuestionDetail`, `QuestionLive`, `QuestionContext`,
  `QuestionStatus`, `QuestionError`, removed reasons, `TreeBusyDetails`, `BlockingQuestion`,
  and `RegistryEvent = QuestionStreamEvent & { seq: number }`.
- `QuestionTimings` + `DEFAULT_QUESTION_TIMINGS`: `attemptTimeoutMs` 30 min, `namingTimeoutMs`
  30 s, `doneTtlMs` 30 min, `doneCapPerTree` 50, `failedTtlMs` 24 h, `failedCapPerTree` 50,
  `pingIntervalMs` 15 s, `retryMs` 2 s, `maxBufferedBytes` 1 MiB.

`server/src/questions/title.ts` (create) — `questionTitle(text, fileNames)`: `firstLine` +
`collapseWhitespace`, `truncateGraphemes(…, 80, '…')`; empty text → file names joined by `, `.

`server/src/questions/registry.ts` (create) — `QuestionRegistry`, synchronous, no I/O
- `constructor({ timings, onRemoved?(info, reason) })`; `readonly instance = randomUUID()`.
- Entries: `Map<id, { info, live: QuestionLive | null, timer? }>`; `seq` counter; subscribers
  `Set<{ tree?, onEvent, onEnd }>`; settled waiters.
- Mutations (each emits exactly the events of the contract, synchronously):
  - `add(info)` → `question`.
  - `appendChunk(id, attempt, text)` → `chunk{offset = live.answer.length}` then append. Ignored
    unless the entry exists, is `streaming` and `attempt` matches.
  - `attachment(id, attempt, event)` → fold into `live.attachments` (replace by `key`, else
    push) → `attachment`. Same guards (only while `streaming`; late events are dropped, which
    gives ordering guarantee 3/4).
  - `setNaming(id, attempt)`, `complete(id, attempt, { nodeId, attachments, files })` (live →
    null; schedule done TTL; enforce done cap), `fail(id, attempt, error)` (keep partial live;
    schedule failed TTL; enforce failed cap → `removed{evicted}`).
  - `beginAttempt(id)` → failed ➝ streaming, `attempt + 1`, live reset, TTL cleared → `question`.
  - `remove(id, reason)` → `removed` (+ `nodeId` for done), `onRemoved` callback, settle waiters.
  - `remap(tree, map)`: for retained (non-running) entries rewrite `parentId`,
    `context.anchor`, done `nodeId` by the prefix rule; fix an anchor that is no longer an
    ancestor-or-self (`anchor = parentId`); emit `question` for changed entries only.
  - `dropUnder(tree, ids)`: remove retained entries whose `parentId` (or done `nodeId`) is the
    same as or inside an id → `removed{deleted}`.
  - `renameTree(oldId, newId)`: rewrite `tree`, emit `question` per entry.
- Reads: `get(id)`, `detail(id)`, `list(tree?)` (sorted by `createdAt`),
  `blockers(treeId, holders)` → `{ questions: running entries whose id is a holder, preparing:
  holders without a running entry }`.
- `subscribe({ tree?, onEvent, onEnd }) → { snapshot: { seq, instance, questions }, unsubscribe }`
  — snapshot and listener registration in the same synchronous call. Listener errors are
  swallowed (like staging `emit`).
- `settled(id): Promise<QuestionInfo | undefined>` — resolves on the next `done`/`failed`/removal
  of the current attempt, immediately if already terminal or absent (test helper and DELETE).
- `endSubscribers()` (calls every `onEnd`), `close()` (clears timers, drops entries, settles
  waiters). All timers `unref()`'d.

`server/src/questions/runner.ts` (create) — `runAttempt(job, deps): Promise<void>`
- `QuestionJob`: `id, attempt, treeDir, parentId, text, question` (agent text or
  `EMPTY_TEXT_QUESTION`), `namingQuestion, model, namingModel, instructions, chain,
  promptFiles, staging: AnswerStaging, controller, release, committing, finished`.
- Abort reasons on `controller.abort(reason)`: `'cancel' | 'timeout' | 'shutdown'`.
- Sequence (mirrors today's `messages.ts`, minus SSE):
  1. Watchdog `setTimeout(abort('timeout'), attemptTimeoutMs).unref()`.
  2. `agent.ask({ …, files: promptFiles, signal, staging, stagingDir: staging.dir })`; chunks →
     `registry.appendChunk`; no `done` → error.
  3. `await staging.seal()` (all attachment events land before `naming`).
  4. `registry.setNaming`.
  5. `agent.name({ question: namingQuestion, answer: answer.text, model: namingModel, signal:
     AbortSignal.any([controller.signal, AbortSignal.timeout(namingTimeoutMs)]) })`; on error:
     if `controller.signal.aborted` → abort path, else `fallbackNodeName(namingQuestion)`.
  6. Check `controller.signal.aborted` and set `committing = true` in the same tick; clear the
     watchdog; `await deps.hooks?.beforeCommit?.(id)` (test seam).
  7. `createNode(treeDir, parentId, name, { created, model: answer.model, user: text, assistant:
     answer.text }, { stagingDir: staging.dir })`, then `listAttachments`/`listUserFiles` of
     the node.
  8. `staging.release()`, lock `release()`, then `registry.complete(…)` (guarantee 5).
- Failure path (not cancel/shutdown): code `timeout` if the abort reason is `'timeout'`,
  `internal` if the error came from seal/commit/listing, else `agent_error`; message = error
  message (as today's SSE `error`). Then `held.hold(id, staging.dir)` (log on error),
  `staging.discard()`, lock `release()`, `registry.fail(…)` (guarantee 6). If `createNode`
  failed after `committing`, the staging folder still exists and follows the same path.
- Cancel path (`'cancel'`): `staging.discard()`, lock `release()`, `registry.remove(id,
  'cancelled')`. Shutdown path: same teardown, no events.
- `finally`: clear the watchdog, resolve `job.finished`; never throws (errors are logged).

`server/src/questions/service.ts` (create) — `class Questions`
- `constructor({ agent, locks, treesDir, allowPrivateUrls, heldDir?, timings?, log?, hooks? })`;
  builds `registry` (with `onRemoved` → `held.discard(id)` for entries that held files) and
  `held = createHeldFiles({ root: heldDir })`.
- `instance`, `registry` (read-only, for tests), `subscribe`, `settled`, `blockers`, `remap`,
  `dropUnder`, `renameTree` (delegates).
- `start(input): QuestionInfo` (sync): build the `RunningQuestion` (title, files sorted by name,
  timestamps), `registry.add`, create the job, `job.finished = runAttempt(job)`, return info.
  `input` = what the route prepared: `id, tree, treeDir, parentId, context, text, model,
  namingModel, instructions, chain, staging, files, promptFiles, controller, release`.
- `retry(id): Promise<QuestionInfo>`:
  1. 404 `question_not_found`; 409 `question_not_failed` unless `failed` and not preparing.
  2. Register a prep `AbortController` (+ its promise) in `preparing`.
  3. `locks.acquireShared(tree, id)` → `existingTreeDir` → `readTree` → `readChain(parentId)`
     (map `NotFoundError` → 404 `parent_not_found`, message `Parent node not found: <id>`) →
     `sweepStaleStaging` → `createAnswerStaging({ signal: new attempt controller, onEvent: e =>
     registry.attachment(id, attempt + 1, e) })` → `held.restore` (only if `files.length`) →
     `stagedPromptFiles`.
  4. On any error or prep abort: if files were restored, `held.hold` them back; discard
     staging; release the lock; rethrow (entry unchanged). Unexpected errors → 500.
  5. `registry.beginAttempt(id)`, create the job, run it, return the info.
- `remove(id): Promise<void>` (DELETE semantics of the contract): unknown → 404; preparing →
  abort the prep, await it, dismiss; running and `committing` → `await job.finished`, then
  re-evaluate; running → `controller.abort('cancel')`, `await job.finished`; `done` → 409
  `question_finished` with `details: { nodeId }`; `failed` → `registry.remove(id, 'dismissed')`.
- `endStreams()` → `registry.endSubscribers()`.
- `close()`: abort every job (`'shutdown'`) and prep, `await Promise.allSettled(finished)`,
  `registry.close()`, `held.close()`.

`server/src/routes/sse.ts` (create) — `openSse(reply, { retryMs, pingIntervalMs,
maxBufferedBytes })`
- `reply.hijack()`, `writeHead(200, headers from the contract)`, write `retry: <ms>\n\n`.
- `send(seq, event, data)` writes `id:`/`event:`/`data:`; if `raw.writableLength >
  maxBufferedBytes` after a write → `raw.destroy()` (slow consumer; client resyncs).
- `: ping\n\n` interval (`unref()`), `end()`, `onClose(cb)`; cleanup on `close`.

`server/src/routes/message-input.ts` (change)
- `messageBody` gains `context: questionContext.optional()` (discriminated union `main` |
  `side{anchor: nodeId}` defined in `schemas.ts`); `messagePayload` inherits it. Update the
  "Constants mirror …" comment to the new contract.
- Move `pickModel` here from `messages.ts`; add `validateContext(parentId, context)` (pure;
  400 `InvalidInputError` when a side anchor is not the parent or an ancestor).

`server/src/routes/questions.ts` (create)
- `POST /trees/:tree/questions` — port of `messages.ts` up to the hijack, in the contract's
  validation order: `openMessageInput` → `pickModel` ×2 → `validateContext` →
  `existingTreeDir` → `id = randomUUID()` → `locks.acquireShared(treeId, id)` (errors: drain,
  rethrow). `raw.on('close')` aborts only during `prepare()` (readTree, readChain → 404
  `parent_not_found`, `sweepStaleStaging`, `createAnswerStaging` with `onEvent` →
  `registry.attachment(id, 1, e)`, stager + `receiveUserFiles`, `empty_message` check). On
  prepare error: same cleanup as today. After prepare: `raw.off('close')`; if the controller is
  already aborted, tear down like an upload abort; else `questions.start(…)` and reply `202`
  with `location: /api/questions/<id>` and `{ question }`.
- `GET /questions` (`querystring: { tree?: string }`) → `{ instance, questions }`.
- `GET /questions/events` (`querystring: { tree?: string }`) → `openSse` + `subscribe`; write
  the snapshot (its `seq` as `id`) right after subscribing; forward events; unsubscribe on
  close (never touches jobs).
- `GET /questions/:id`, `DELETE /questions/:id` (204), `POST /questions/:id/retry` (202 +
  `location`); params `z.object({ id: z.uuid() })`.

`server/src/routes/messages.ts` — delete.

`server/src/app.ts` (change)
- `AppDeps.questions?: Questions`, `RouteDeps.questions: Questions`; default
  `new Questions({ agent, locks, treesDir, allowPrivateUrls, log: app.log })`.
- Register `questionRoutes` instead of `messageRoutes`.
- Error handler: `TreeBusyError` with code `tree_busy_streaming` → `details =
  questions.blockers(error.treeId, error.holders)`. Every exclusive route gets the details
  without route changes.
- `app.addHook('preClose', () => questions.endStreams())`; `app.addHook('onClose', () =>
  questions.close())` (also for injected instances; `ctx.close()` in tests relies on it).

### Step 7 — Structural routes keep retained questions consistent

- `server/src/routes/nodes.ts` (inside `withExclusive`, after success):
  delete → `questions.dropUnder(tree, Object.keys(deleted))`; move →
  `questions.remap(tree, moved)`; rename → `questions.remap(tree, { [id]: result.id })` when the
  id changed; restore → nothing.
- `server/src/routes/trees.ts` title `PATCH`: when `result.id !== tree` →
  `questions.renameTree(tree, result.id)` (inside the exclusive section).

### Step 8 — Entry point and script

- `server/src/index.ts`: `await sweepHeldRoots().catch(log)` before `listen`; SIGINT/SIGTERM →
  `app.close()` then `process.exit(0)`, with a 10 s `unref()`'d force exit. (`tsx watch`
  restarts then discard staging folders cleanly.)
- `server/scripts/ask.ts`: already updated in steps 2-3; still writes nothing.

### Step 9 — Docs (developer reviews)

- `README.md`: features (parallel questions with pending nodes; answers continue in the
  background and after reload; cancel/retry; names in the answer's language; Unicode folder
  names); "How it works" steps 4-5 (202 + event stream; naming after the answer).
- `CLAUDE.md` Architecture → Server: replace the `routes/messages.ts` message flow with the
  question flow (`routes/questions.ts`, `questions/` registry/runner/service, app-wide SSE,
  retention, held files), Unicode node-name rules (`node-names.ts`, NFC, `nameKey`), lock
  holders; test helpers (`ctx.questions`, `askAndSettle`, `openEventStream`).

### Step 10 — Verify

- `pnpm check` (or `pnpm format`), `pnpm lint`, `pnpm --filter @otago/server test`.
- Manual (real SDK, `pnpm dev`, coordinated with the web): two parallel questions in one tree;
  reload mid-stream and see catch-up; cancel; a failed question retried with files; a
  Cyrillic answer gets a Cyrillic node name; heartbeats pass the Vite proxy and closing the tab
  closes the upstream connection; `Ctrl+C` leaves no `.tmp-answer-*` folders.

## Test plan (Vitest, `fakeAgent()` only, no real SDK)

### `server/test/helpers.ts` (change)
- `fakeAgent`: `gate` raced with `input.signal` (abort/timeout tests cannot hang), `nameGate`,
  `nameError`, records `NameInput.answer` and `AskInput.stagingDir`.
- `makeApp(agent, models, extra: { allowPrivateUrls?, locks?, timings?, hooks? })` creates a
  separate held temp dir and a `Questions` instance, and returns `{ app, treesDir, heldDir,
  locks, questions, events, close }`. `events` = `recordEvents(questions)`: an in-process
  subscriber started before any request, with `forQuestion(id)` and `text(id, attempt?)`.
- `askAndSettle(ctx, body, tree = 'rust')` → POST, expect 202, `await
  ctx.questions.settled(id)`, return `{ res, question, events }` (replaces `parseSse(res.body)`).
- `openEventStream(baseUrl, query?)` → `fetch` + incremental parser (`id:`, `retry:`, comments)
  with `frames`, `next(predicate, timeoutMs)`, `close()`. `parseSse` learns `id:`/`retry:`/
  comments. Move `deferred()`/`tick()`/`perQuestionAgent` here.

### New test files
- `test/node-names.test.ts`: `toNodeName` table (Cyrillic, CJK, Devanagari marks, Greek
  Final_Sigma, `İ`, `ﬁ`/full-width via NFKC, ZWJ/emoji → fallback, `../../etc/passwd`,
  `maxWords`, 60-code-point and 100-byte caps, word dropping before grapheme cutting, astral
  characters at the cut, idempotence, seeded random-string property `isNodeName(toNodeName(x))`);
  `isNodeName` (ASCII slugs valid, NFD/uppercase/`a--b`/`-a`/`x.deleted-1`/ZWJ/RLM invalid);
  `nameKey` collisions (`straße`/`strasse`, `λόγος`/`λόγοσ`, `ﬁles`/`files`) and non-collisions
  (`ёлка`/`елка`).
- `test/held-files.test.ts`: hold/restore/discard round trip; no `files/` → no-op; restore of a
  missing id throws; `close()` removes only an owned root; `moveDir` EXDEV fallback via an
  injected `rename`; `sweepHeldRoots` removes only old `otago-held-*` folders (utimes).
- `test/question-registry.test.ts` (fake timers, no HTTP): add/seq; snapshot+subscribe
  atomicity; chunk offsets and attempt/status guards; attachment folding (latest per key, first
  appearance order) and drop after naming; naming/complete (live null)/fail (partial kept);
  `beginAttempt` order (question before chunks); `remove` with `nodeId` for done; `settled`;
  done TTL + done cap (`expired`); failed TTL (`expired`) + cap (`evicted`) + `onRemoved`;
  `remap` prefix rule incl. `/` boundary (`a` does not touch `ab`) and anchor fix-up, events only
  for changed entries; `dropUnder` (parent and done `nodeId`); `renameTree`; `blockers`
  (`preparing` for unknown holders, failed/done excluded); tree filter; throwing listener
  isolated; `endSubscribers`.
- `test/questions-api.test.ts` (replaces `messages-api.test.ts`; `inject` + `ctx.events`):
  202 shape + `location`; event sequence `question(streaming)` → `chunk`×n (offsets) →
  `question(naming)` → `question(done{nodeId, attachments: [], files: []})`; `node.md` content
  and agent call args; default/requested models; 400 unknown model (no entry, lock idle); child
  + chain; naming sees the full answer and runs after the last chunk; naming error/timeout →
  fallback (incl. a Cyrillic question → Cyrillic name); agent failure → `failed{agent_error}`,
  partial `live.answer`, nothing on disk, no `.tmp-*`, lock idle; 400/404 `tree_not_found`/
  404 `parent_not_found`; `context` echo, default `main`, bad anchor → 400; concurrent questions
  (same parent → distinct nodes; main + side parents); structural op during a question → 409
  with `details.questions[0]` = `{ id, tree, parentId, context, title, status: 'streaming' }`,
  `preparing: 0`; start under an exclusive lock → 409 `tree_busy_structural`, agent not called;
  DELETE running → 204, `removed{cancelled}`, nothing written, lock idle, the other question
  completes; DELETE during naming → cancelled; DELETE at commit (`hooks.beforeCommit` gate) →
  409 `question_finished` + `nodeId`; DELETE done → 409; DELETE failed → 204 `dismissed`;
  unknown → 404 `question_not_found`; non-UUID → 400; retry (agent failing once) → 202 same id,
  attempt 2, `question` before attempt-2 chunks, node created; retry of running/done and a
  concurrent retry → 409 `question_not_failed`; retry under an exclusive lock → 409, entry
  stays failed; retry after the parent folder was removed on disk → 404 `parent_not_found`,
  entry stays failed; watchdog (`attemptTimeoutMs: 50`) → `failed{timeout}`; a fetch-POST
  aborted right after its 202 still creates the node; `GET /questions` (+ `?tree`) and
  `GET /questions/:id` (`live` null when done); old tree id after rename → 404 `tree_not_found`;
  `POST /trees/:tree/messages` → 404; Unicode end-to-end (Cyrillic node id, NFD
  percent-encoded `?node=`/`parentId` normalized to NFC).
- `test/questions-stream.test.ts` (`listen` + `openEventStream`): headers, `retry: 2000`,
  first event `snapshot` with `instance` and `id`; catch-up after connect (snapshot
  `live.answer` so far, next chunk offset continues); snapshot carries `live.attachments` and
  `files` of a running multipart question; two subscribers see identical sequences; closing a
  stream does not affect the job; `?tree=` filter; ping with `pingIntervalMs: 30`;
  `ctx.close()` resolves quickly with an open stream and a gated running question, no
  `.tmp-*` left, held root removed; two app instances have different `instance` ids.
- `test/sse.test.ts`: `openSse` with a fake `raw` — framing, ping, destroy above
  `maxBufferedBytes`, cleanup on close.

### Ported / changed test files
- `test/messages-api.test.ts` → deleted (ported to `questions-api.test.ts`).
- `test/message-files-api.test.ts` → `test/question-files-api.test.ts`: same cases on
  `POST /questions` + `askAndSettle`; 202 `question.files` = staged metadata; title of a
  files-only message = file names; rejection table also asserts "no entry"
  (`GET /questions` empty); "disconnect during the stream" becomes "DELETE during the stream →
  nothing written"; "disconnect during the upload" stays (nothing written, agent never runs,
  no entry, lock idle). New: failure holds the files (`heldDir/<id>/files/…`, nothing under
  `trees/`), retry commits them, dismiss removes them; a failed question whose parent was moved
  retries under the new parent with its files. `GET /trees/:tree/files` tests unchanged.
- `test/attachments-api.test.ts`: post via `askAndSettle`; assertions read `attachment` events
  (with `attempt`) from `ctx.events`; "client disconnect → no node" becomes "cancel → no node
  and staging removed"; 409 while a save is pending includes `details`.
- `test/nodes-api.test.ts`: 409 `toEqual` bodies gain `details: { questions: [], preparing: 1 }`
  (anonymous `acquireShared`); failed question remapped after move and after rename (with a
  `question` event), removed after delete (`removed{deleted}`), not restored by restore;
  Unicode rename (`Привет` → `привет`), Unicode move `names`, NFD `?node=` and trash ids.
- `test/trees-api.test.ts`: 409 bodies with `details`; a tree rename rewrites `tree` on failed
  questions and a tree-less retry still works.
- `test/agent.test.ts`: sanitize table (`Привет` → `привет`, `Café crème` → `café-crème`, …);
  `fallbackNodeName` in Cyrillic; `namingExcerpt` cleaning/cut/empty; `buildNamingPrompt`
  (labeled examples, 500-grapheme question cut, `(no prose)`); `touchesForeignTemp` (other
  staging denied in Read/Grep/Glob, own staging relative and absolute allowed, Grep `pattern`
  ignored); `buildAskOptions` wires `pathGuardMatcher`; system rule text; `TreeLocks` holders
  (record, release, anonymous, `TreeBusyError.treeId/holders`).
- `test/storage.test.ts`: `toKebabCase` tests → `toTreeId` (still ASCII: `Привет` → `node`);
  Cyrillic `createNode`; fold collisions (`straße` then `strasse` → `strasse-2`); `readHierarchy`
  NFC ids for a hand-made NFD folder (`it.skipIf(process.platform !== 'darwin')`); NFD id → 400
  at the storage layer; Unicode `DELETED_NAME_RE`/`parseTrashId`; `A.deleted-…` invalid;
  reserved by key (`ﬁles` segment → 400).

## Risks and notes for the implementer

- **Cancel/commit race:** the abort check and `committing = true` must happen in one tick;
  DELETE reads `committing` synchronously. Covered by the `beforeCommit` test hook.
- **Fastify shutdown:** hijacked SSE replies must be ended in `preClose` or `app.close()` hangs
  (tests would hang in `ctx.close()`).
- **`inject` cannot read an endless SSE response:** stream tests use `listen` + `fetch`; other
  tests use the in-process recorder.
- **Background errors** have no request logger: the service logs through `app.log` (no-op when
  injected without a logger).
- **Zod 4 record keys:** confirm `normalize` on the `names` key schema; otherwise normalize keys
  in the handler.
- **Behavior change:** closing the tab no longer stops an answer (cost keeps running); the
  watchdog and 409 blocker details are the mitigations. No concurrency cap (non-goal);
  `acquire*` and `Questions.start` are the seams.
- **Restore after delete** does not bring back failed questions removed by the delete
  (documented in the contract).
- **Linux NFD folders** created outside Otago are listed but cannot be opened by their NFC id
  (documented limitation).
