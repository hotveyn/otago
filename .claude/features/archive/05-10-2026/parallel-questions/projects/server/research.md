# Research: parallel-questions, project `server`

Stage 2 (research) output. Nothing here is a plan or production code. Type sketches only illustrate shapes for the planning stage.

## 1. Context

### 1.1 Stack (verified in `server/package.json` and the installed modules)
- Fastify 5.12.5 with `fastify-type-provider-zod` 7 and Zod 4.6.5. TypeScript 7, ESM, Node >= 22 (24.14 locally).
- `@anthropic-ai/claude-agent-sdk` 0.3.x. Every `query()` call spawns the Claude Code CLI and is cancelled through an `AbortController`.
- Vitest 5. Tests call `buildApp` with `fakeAgent()`. Request/response tests use `app.inject`. Disconnect tests use `app.listen` + `fetch` + `AbortController`.
- The browser always talks to the server through Vite's dev proxy (`web/vite.config.ts`, `/api` -> `127.0.0.1:3001`). Vite drops HTTP/2 when `server.proxy` is used, so the browser side is **HTTP/1.1 with at most 6 connections per origin**. Every open SSE response uses one of those 6.

### 1.2 Existing patterns this feature touches (verified)
- **Message route** (`src/routes/messages.ts`). The flow is: `openMessageInput` -> `pickModel` -> `existingTreeDir` -> `locks.acquireShared` (L53) -> `prepare()` (readTree, readChain, `sweepStaleStaging`, `createAnswerStaging`, `createUserFileStager` + `receiveUserFiles`, empty check). Then `reply.hijack()` and a hand-written SSE (`event:`/`data:` lines, L112-123). `agent.name()` starts in parallel with `ask()` and sees only the question (L125). The answer is followed by `seal` -> `createNode` -> a `done` event with `listAttachments`/`listUserFiles`. `raw.on('close')` aborts the whole run (L63-65). The lock is released in `finally` **after** `done` is written, so the done payload can read the node folder safely.
- **Lock** (`src/agent/lock.ts`). `TreeLocks` is a synchronous, in-memory readers-writer lock. Shared holders are unlimited, exclusive conflicts throw 409 `tree_busy_streaming`/`tree_busy_structural`, and releasers are idempotent. `acquire*` is documented as the seam for future policy. The lock is injectable via `AppDeps.locks` and returned by `makeApp` for test assertions.
- **Staging** (`src/storage/attachments.ts`). `createAnswerStaging` runs `mkdtemp(<parentDir>/.tmp-answer-)` and registers the folder in the module-level `activeStaging` set. `seal()` closes saves and drops an empty `attachments/`. `discard()` removes the folder. `sweepStaleStaging(parentDir, 1h)` skips folders in `activeStaging`. User files go to `<staging>/files/` (`src/storage/user-files.ts`), and `promptFiles(treeDir)` builds the prompt lines from the files the stager staged itself. `listUserFiles(dir)` can list any folder.
- **Naming** (`src/agent/prompt.ts`, `src/agent/claude-agent.ts`). `NAMING_PROMPT` forces "2-4 lowercase English words". `name()` sends `question.slice(0, 2000)`, `maxTurns: 1`, no tools. `sanitizeNodeName` and `paths.ts` `toKebabCase` are two copies of the same ASCII logic: NFKD, strip U+0300-036F, `[^a-z0-9]` -> separator. As a result a Cyrillic name collapses to `node`, and `й` would become `и`.
- **Slug rules** (`src/storage/paths.ts`). `SLUG_RE` is shared by tree ids (`treeDirOf`, `listTrees`) **and** node segments (`nodeIdSegments`, `readChildren`, `moveNodes` `names`). `toKebabCase` builds tree ids (`createTree`, `updateTree`) **and** node names (`createNode`, `renameNode`). `DELETED_NAME_RE` embeds the ASCII slug in its `name` group.
- **Unique names** (`src/storage/fs-utils.ts`). `pickName`, `takenNames` and the in-process `claims` compare names as exact strings. `createNode`/`renameClaimed` retry 10 times on `EEXIST`/`ENOTEMPTY`, but each retry re-reads `readdir` and can pick **the same** candidate again.
- **Conventions.** Errors are `AppError` subclasses with machine codes, typed as unions in `errors.ts`. Dependencies are injected through `RouteDeps`/`AppDeps`. Race-free state changes happen synchronously in one tick (`TreeLocks`, `claims`, `activeStaging`). Listener errors are swallowed (the `emit` in staging). Ids that contain `/` travel in bodies and query strings (`?node=`), never in path params. `DELETE /trees/:tree/sources/:file` is the precedent for a path-param delete.
- **No shutdown handling.** `app.ts` registers no `preClose`/`onClose` hook, and `index.ts` installs no SIGTERM/SIGINT handler.

### 1.3 Facts verified with local probes (Node 24, this Mac's APFS)
- Fastify decodes percent-encoded UTF-8 in query strings and path params. It does **not** normalize: an NFD id arrives as NFD (23 vs 22 code units).
- Zod 4.6 has `z.string().normalize('NFC')`. It runs as an overwrite before later checks such as `.max()`.
- The APFS here is **normalization-insensitive and normalization-preserving**. `readdir` returns NFC when NFC was written. `mkdir` of the NFD twin fails with `EEXIST`. `stat` through the NFD path works.
- The volume is **case-insensitive with full case folding**. These pairs collide (`EEXIST`, or `ENOTEMPTY` on `rename`): `ß`/`ss`, `ς`/`σ`, `ﬁ`/`fi`, `k`/`K` (Kelvin). These do not: `ё`/`е`, `i̇`/`i`.
- `s.normalize('NFC').toUpperCase().toLowerCase()` reproduces exactly those collisions and non-collisions, so it works as a sibling comparison key.
- `toLowerCase()` is locale-independent and applies Final_Sigma (`ΟΔΟΣ` -> `οδος`). `'İ'.toLowerCase()` gives `i̇` (i + U+0307).
- `String.prototype.slice` can split a surrogate pair (`'𠀀𠀀'.slice(0, 3)`).
- `/^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*$/u` accepts Cyrillic, CJK, Latin with diacritics, and Devanagari (which needs `\p{M}`). It rejects `a--b`, `-a`, `x.deleted-1` and ZWJ.

## 2. Approaches

### 2.1 API shape and transport (focus 1, 2, 6)

**A1. Keep POST-SSE, add a re-attach endpoint and a polled list.**
`POST /trees/:tree/messages` keeps streaming but no longer aborts on disconnect, and its first event carries the question id. A new `GET /trees/:tree/questions/:id/stream?from=<offset>` re-attaches. `GET /trees/:tree/questions` is polled for pending/failed nodes.
- Smallest diff on both sides.
- The tab that started N questions holds N connections until they finish. With the 6-connection HTTP/1.1 limit, five parallel answers starve all other `/api` traffic, including chat images and attachment previews. To avoid that, the client must abort its own POST once the chat goes to the background, then re-attach later. There are two ways to receive the same chunks, and polling adds latency and load for status changes.

**A2. Start returns an id; one SSE per question; a lifecycle channel for the graph.**
`POST /trees/:tree/questions` returns 202 with the id. `GET .../questions/:id/events?from=` follows one question and ends at its terminal state. Graph status comes from polling or a tree-level lifecycle SSE.
- Clean REST shape. The per-question stream ends, so it works with `inject` in tests.
- The client must attach/detach as the foreground chat changes and must handle the race between list and attach. The graph needs a second mechanism. That makes 2-3 connections per tab.

**A3. Start returns an id; one multiplexed event stream (snapshot + deltas) per tab.**
`POST /trees/:tree/questions` returns 202 with the id. One SSE stream sends a `snapshot` of every in-flight question, including the text so far, then multiplexed lifecycle, chunk, attachment and removal events. Small JSON endpoints cover list, detail, cancel/dismiss and retry.
- One connection per tab, whatever the number of questions.
- The client keeps one ordered source of truth (a reducer keyed by question id) for pending nodes, background asides, reload and future multi-tab.
- "Finished between list and attach" disappears: there is no separate attach step. Completion is just an event.
- Costs: chunks of questions nobody is looking at still reach every tab, which is negligible for local text. The stream never ends, so tests need `listen` + `fetch`, or they observe the registry directly. The snapshot is resent on every reconnect, which is bounded by answer sizes.
- Scope sub-options:
  - **Per tree** (`/trees/:tree/questions/events`) matches the route layout, but switching trees reconnects and other trees are invisible.
  - **App-wide** (`/questions/events`, optional `?tree=` filter) survives tree switches, handles a tree rename by re-keying, and is what cross-tree completion notifications will need.

**Rejected.** WebSocket: there is no client->server streaming need, it adds `@fastify/websocket`, and the codebase already uses SSE. Polling chunks: latency and overhead.

**SSE implementation choice.**
- Hand-rolled helper, as in `messages.ts` today: `writeHead`, `send(id, event, data)`, heartbeat, close.
- `@fastify/sse` (0.6.0, pre-1.0, republished today). It brings `heartbeatInterval`, `reply.sse.replay(lastEventId)` and backpressure-aware streams, but it is a young, fast-moving dependency. The helper is about 40 lines, and the codebase already owns this pattern.

### 2.2 In-flight registry (focus 1)
- **R1. Hand-rolled in-memory registry class.** Same style as `TreeLocks`: synchronous state changes, a `Set` of listener callbacks with errors swallowed, timers `unref()`'d, injected through `AppDeps`. It fits the existing conventions.
- **R2. A job library** (BullMQ, p-queue, ...). BullMQ needs Redis. Persistence, retries with backoff and queueing are all non-goals. Rejected.
- **R3. A Node stream per question** (`PassThrough` + a replay buffer). Awkward when one question has many subscribers, each needing its own replay offset, plus status snapshots. Rejected.

### 2.3 Resume and replay (focus 2)
- **P1. Snapshot on connect, then deltas.** Each chunk event carries `offset` (UTF-16 length of the answer before the chunk, which is the same unit on both JS ends) and `attempt`. The client applies a chunk only past its current length, so a duplicate is idempotent and a gap is detectable.
- **P2. Last-Event-ID with a ring buffer.** A global sequence number per event, a bounded buffer, and on reconnect only the missed events are replayed. Fall back to a snapshot when the id is too old. Fewer bytes on reconnect, more state, and still needs P1 as the fallback.
- **P3. Per-question `?from=<offset>` attach.** One catch-up chunk `text.slice(from)`, then live chunks. Belongs to A1/A2.

### 2.4 Keeping files for Retry without leaking disk state (focus 3)
- **F1. Leave the failed staging folder in place** (`<parent>/.tmp-answer-*`, `files/` only, partial `attachments/` removed) and keep it in `activeStaging` so sweeps skip it.
  - No copying.
  - The folder moves with its parent, goes to trash with it, and comes back on restore as a stale `.tmp-` folder. A tree rename makes its absolute path stale.
  - Other questions' agents can Glob it for longer.
- **F2. Move `files/` to a server-private holding folder outside `trees/`** (`mkdtemp(os.tmpdir()/otago-held-)` per process, injectable) and discard the staging folder. Retry creates a fresh staging folder under the (current) parent and moves the files back in.
  - Fully decoupled from tree structure and git status.
  - On Linux with tmpfs `/tmp` the rename fails with `EXDEV`, so it needs a `cp` + `rm` fallback (at most 10 x 20 MB).
- **F3. Keep nothing on the server; the client re-uploads on Retry.**
  - Simplest.
  - Retry of a file message is impossible after a reload, and the client must keep `File` objects for background chats.
- Orthogonal choice: does a failed entry keep the shared lock? The NFR says the lock is held "until done/failed/cancelled", so a failed entry releases it. Moves, deletes and renames can then change its parent. Either Retry rejects with 404 (and the failed node dangles in the graph), or the registry **remaps** `parentId` the same way the web undo stack does, using the id maps that the structural routes already return (`moved`, `renamed`, `deleted`).

### 2.5 Naming after the answer (focus 4)
- **N1. Today:** name from the question, in parallel. Fails the requirement for the answer's language.
- **N2. After the answer, with the question plus a cleaned, truncated excerpt of the answer.** Prose is kept; code fences, mermaid blocks, footnote definitions/refs, URLs and images are dropped, and the excerpt is about 1500 chars cut at a word boundary. Code-heavy answers otherwise bias the language toward English.
- **N3. After the answer, with the full answer.** More latency (answers can run to tens of KB, and Cyrillic tokenizes about 2-3x worse) and no quality gain for a 2-4 word name.
- **N4. Deterministic language detection, then naming.** Extra dependency, and the model already does this reliably.
- Cost note: Haiku-class input is about $1 per million tokens, so a 1-2k-token naming prompt costs about $0.001-0.002. The real cost is latency. Naming now runs **sequentially** after the answer, and each SDK `query()` spawns a CLI process (about 1-3 s), so the pending node stays in a visible `naming` state.

### 2.6 Unicode folder names (focus 5)
- **U1. Stay ASCII and transliterate.** Fails the requirement.
- **U2. Restricted Unicode slug.** Words are made of `\p{L}`, `\p{M}` (only after a base character) and `\p{Nd}`, joined by `-`. NFKC on input, `toLowerCase()`, NFC on output, collision checks on a fold key, capped by code points and UTF-8 bytes.
- **U3. Allow almost anything except separators and control characters.** Spaces, punctuation and dots in ids make URLs and the trash marker ambiguous. Rejected.

## 3. Trade-offs

| Topic | Option | Correctness | Complexity (server / web) | Fit with codebase | Future multi-tab / notifications |
|---|---|---|---|---|---|
| Transport | A1 POST-SSE + re-attach | Starves the 6-connection pool with parallel questions unless the client aborts its own POSTs | Low / medium-high (two chunk paths) | Close to today | Weak (polling) |
| | A2 start + per-question SSE | Good | Medium / medium-high (attach/detach orchestration) | Good | Needs a second lifecycle channel |
| | **A3 start + one multiplexed stream** | **Good. Single ordered source** | **Medium / medium (one reducer)** | **Good. The registry mirrors `TreeLocks` style** | **Native: every tab gets every event** |
| Replay | **P1 snapshot + offsets** | **Idempotent, gap-detectable** | **Low** | - | Works for any number of tabs |
| | P2 Last-Event-ID ring buffer | Good | Medium | - | Optimization, add later |
| Retry files | F1 in place | Paths go stale on move, rename or tree rename. Stale tmp folders end up in trash | Medium (path tracking) | Reuses staging | - |
| | **F2 holding folder outside trees** | **Unaffected by structure** | **Low-medium (EXDEV fallback)** | **New small storage module** | - |
| | F3 client re-upload | Breaks after reload | Low / medium | - | Breaks multi-tab Retry |
| Naming | **N2 question + cleaned excerpt** | **Answer language** | **Low** | **Same `name()` seam** | - |
| Names | **U2 restricted Unicode slug** | **Safe, FS-aware** | **Medium (paths, fs-utils, tests)** | **Keeps the `-2`/trash schemes** | - |

## 4. Recommended approach

### 4.1 API (A3, app-wide stream; the server owns the contract)
- `POST /api/trees/:tree/questions` takes the same JSON or multipart body as today's `/messages`, plus an optional `context`. It responds **202** `{ question: QuestionInfo }` once the files are staged and the job is registered. Every pre-registration error stays exactly as today (400/404/409/413 JSON). A rejected upload **never** creates an entry.
- `GET /api/questions/events[?tree=<id>]` is the one SSE per tab:
  - `retry: 2000` once at the start.
  - Every event has `id: <global seq>`.
  - `: ping` comment every 15 s.
  - Events: `snapshot` `{ questions: QuestionInfo[] }` (with the answer text so far), `question` (upsert: added, status, attempt, remap), `chunk` `{ tree, id, attempt, offset, text }`, `attachment` `{ tree, id, attempt, event: AttachmentEvent }`, `removed` `{ tree, id, reason: 'cancelled' | 'dismissed' | 'expired' | 'parent_deleted' | 'evicted' }`.
- `GET /api/trees/:tree/questions` returns the JSON snapshot for one tree (initial render, tests, tools). `GET /api/trees/:tree/questions/:id` returns detail with the text so far, for resync.
- `DELETE /api/trees/:tree/questions/:id`:
  - **Running** (before commit): cancel. It responds only after teardown (staging discarded, lock released), so the UI's "cancel blockers, then move" works on the next request.
  - **Failed or done**: dismiss.
  - **Commit already started**: 409 `question_finished` with `details.nodeId`.
  - **Unknown id**: 404 `question_not_found`.
- `POST /api/trees/:tree/questions/:id/retry` returns 202 `{ question }` with the **same id**, `attempt + 1` and the text reset.
  - 409 `question_not_failed` if the question is not failed.
  - 409 `tree_busy_structural` from the lock.
  - 404 `parent_not_found`; the entry stays failed.
- Replace `POST /trees/:tree/messages`. The web changes in lockstep, and two code paths would double maintenance. Port its tests (section 4.8).
  - Alternative if planning wants a gradual migration: keep `/messages` as a thin "start + follow one question" adapter on top of the registry, where a disconnect only unsubscribes. The web must not use it for parallel questions.
- Structural 409s (`tree_busy_streaming`) gain `details: { questions: [{ id, parentId, title }] }`. That lets the UI name the blockers. `acquireShared(treeId, holder?)` can record holder ids (this is the documented `acquire*` seam). The route maps them through the registry.
- Shape sketch:
  ```ts
  type QuestionStatus = 'streaming' | 'naming' | 'done' | 'failed';
  interface QuestionInfo {
    id: string; tree: string; parentId: string;
    text: string; fileNames: string[];           // pending title; file-only -> names
    context: { kind: 'main' } | { kind: 'side'; anchor: string }; // echoed, validated, remapped
    model: string; namingModel: string;
    status: QuestionStatus; attempt: number; createdAt: string; updatedAt: string;
    answer?: string;                              // snapshot/detail only
    nodeId?: string; attachments?: AttachmentInfo[]; files?: UserFileInfo[]; // done
    error?: { message: string };                  // failed
  }
  ```
  `context` is the only aside-related data the server stores. The server validates that `anchor` is the parent or one of its ancestors. That is enough to reopen a background aside after a reload without the server knowing anything about tabs.

### 4.2 Registry and lifecycle
- New module `src/questions/`:
  - `registry.ts`: state, subscribers, retention, remap.
  - `runner.ts`: one attempt, ask -> name -> commit or fail.
  - `types.ts`.
  - The registry is injected as `AppDeps.questions` (like `locks`) and returned by `makeApp`. Timings (done TTL, failed TTL/cap, heartbeat, naming timeout) are constructor options, so tests can shrink them.
- **Handover from the request.**
  - Keep today's `prepare()` unchanged, with `raw.on('close')` aborting **only during the upload**.
  - Then register the job, `raw.off('close')`, and reply 202. From then on only `DELETE` aborts.
  - The job owns its `AbortController`. Use `abort(reason)` to tell cancel apart from shutdown.
- **States.** `streaming` -> `naming` -> (`done` | `failed`). A cancelled question is removed immediately. An internal `committing` flag is set right before `createNode`. Cancel is honored only before it.
- **Lock.**
  - The shared lock is acquired before reading the chain (as today) and held through streaming, naming and commit.
  - On success it is released **after** the done payload (`listAttachments`/`listUserFiles`) is read but **before** the terminal event is emitted. A client that reacts to `done` (undo, move) therefore never gets a spurious 409.
  - On failure it is released after the files are moved to holding and staging is discarded.
  - Retry takes a new shared lock.
- **Retention.**
  - `done`: drop the answer text right after commit, since `node.md` holds it. Keep the summary (`nodeId`, `parentId`) for about 5 minutes, then emit `removed{expired}`. A client that does not find a question in the snapshot refetches the tree; the node exists.
  - `failed`: kept until `DELETE` or Retry. Cap of about 50 per tree (evict the oldest with `removed{evicted}` and delete its held files) and a TTL of about 24 h.
  - All timers are `unref()`'d.
- **Structural operations.** Running entries cannot be affected, because they hold the shared lock. For retained entries:
  - After `nodes/move` and `nodes/rename`, call `registry.remapIds(tree, map)` on `parentId`, `context.anchor` and done `nodeId`. This is a prefix remap, like `remapSubtree` and the web undo stack. Emit `question` updates.
  - After `nodes/delete`, call `registry.dropUnder(tree, ids)` and emit `removed{parent_deleted}`.
  - After a tree title rename, call `registry.renameTree(old, new)`.
- **Shutdown.**
  - A `preClose` hook ends every SSE subscriber. Fastify documents this hook for SSE streams that would otherwise keep `server.close()` hanging, and hijacked replies are not drained.
  - An `onClose` hook aborts running jobs, awaits their teardown and removes the holding root. Without this, `ctx.close()` in tests would hang or leak temp files.
  - Optionally, SIGINT/SIGTERM -> `app.close()` in `index.ts`.
- **Optional watchdog.** A maximum runtime per attempt, for example 30 min, marks a hung SDK run as failed, so a forgotten question cannot hold the tree's shared lock forever.

### 4.3 SSE mechanics
- Take the snapshot and register the listener **synchronously in the same tick**, then write the snapshot. Every later event lands after it, with no gap and no duplicate.
- Every chunk carries `offset` and `attempt`. The client appends `text.slice(local.length - offset)` when `offset <= local.length`. When `offset > local.length` it resyncs through the detail endpoint or by reconnecting.
- Last-Event-ID: v1 ignores it and always sends the snapshot. The global `seq` ids leave a seam for a P2 ring buffer later.
- Backpressure: if `raw.writableLength` exceeds about 1 MiB, destroy that subscriber's connection. The client reconnects and gets a fresh snapshot, which is the standard way to drop a slow consumer.
- Cleanup: on `close`, unsubscribe and clear the heartbeat. Never touch the job.
- Optional: coalesce chunks per question every 30-50 ms to cut event and render rates. Offsets keep this safe.
- Order is guaranteed per stream. The 202 response and the `question` added event can arrive in either order, so the client upserts by id.

### 4.4 Retry and held files (F2)
- **On failure:** seal staging, remove `attachments/`, move `files/` to `<heldRoot>/<questionId>/files` (on `EXDEV`, `fs.cp` + `rm`), then discard staging. Keep the partial answer text in memory for display. Nothing remains in `trees/`, which satisfies "nothing written on failure".
- **On Retry:** take the shared lock, `readChain(parentId)` (404 keeps the entry failed), `createAnswerStaging(parentDir)`, and move the held `files/` into the new staging folder.
  - Build the prompt lines with a small storage helper (`listUserFiles(<staging>)` + the existing `promptFileOf` logic) instead of the stager, because the stager only knows files it staged itself.
  - Run attempt N+1.
- **On dismiss or eviction:** `rm` the held folder. On startup, sweep `otago-held-*` folders older than 24 h; they are orphans of a crashed process.
- Disk access stays in `storage/`: a new `storage/held-files.ts` with hold, restore and discard.

### 4.5 Naming (N2)
- `NameInput` gains `answer: string`, and the `Agent.name` doc changes to "name for an exchange". `fakeAgent` records it, so tests can assert that naming saw the answer and ran after it.
- The runner, after `done`:
  1. Emit `naming`.
  2. Run `staging.seal()`.
  3. Call `agent.name({ question: namingQuestion, answer: namingExcerpt(text), model, signal: AbortSignal.any([job.signal, AbortSignal.timeout(30_000)]) })`.
  4. On error, use `fallbackNodeName(namingQuestion)`. With the Unicode sanitizer this fallback now produces a name in the question's language instead of `node`.
- Prompt draft. The examples are labeled by language so the model does not default to English:
  ```
  Name this question-and-answer exchange for a folder.
  - 2 to 4 words, lowercase, joined by hyphens.
  - Use the language and script of the answer's prose (ignore code, links, citations). Do not transliterate or translate.
  - Letters and digits only. Reply with the name only.
  Examples: English: borrowing-rules. Russian: правила-заимствования. German: regeln-der-ausleihe.
  <question>…(<= 500 chars)…</question>
  <answer>…(cleaned excerpt, <= ~1500 chars)…</answer>
  ```
- System prompt: "You name folders. Output only the name."
- One sanitizer for everything: `sanitizeNodeName` = first line -> `toNodeName(..., { maxWords: 4 })` from storage. That removes today's duplicate of `toKebabCase`.
- Prompt injection through the answer can at worst produce an odd name, because the output is sanitized.

### 4.6 Unicode node names (U2)
- Split the rules. Tree ids stay ASCII (`isSlug`/`toKebabCase`, which could be renamed `isTreeId`/`toTreeId`). They are path params everywhere and out of scope.
- New node-name functions (in `paths.ts` or `storage/node-names.ts`):
  - `NODE_WORD = [\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*` and `NODE_NAME_RE = ^W(?:-W)*$` with the `u` flag. This excludes `\p{Cf}`, so bidi controls and ZWJ are out, along with emoji and punctuation.
  - `toNodeName(input, { fallback = 'node', maxWords? })`:
    1. NFKC (folds `ﬁ`, full-width letters, superscripts).
    2. `toLowerCase()` (locale-independent; `toLocaleLowerCase` is never used).
    3. Split on `[^\p{L}\p{M}\p{Nd}]+` and drop leading marks of each word.
    4. Optionally keep only `maxWords` words.
    5. Join with `-`.
    6. Cap at **60 code points and 100 UTF-8 bytes**: drop whole words first, then cut at a grapheme boundary with `Intl.Segmenter`, never with `slice`.
    7. Normalize to NFC.
    8. Return `fallback` if empty.
    The 100-byte cap leaves room for `-NN` and `.deleted-<13 digits>-NN` (about 25 bytes) under the 255-byte component limit, and slows down hitting the 1024-byte PATH_MAX on deep multibyte trees.
  - `isNodeName(s)` means non-empty, matches the pattern, `s === s.normalize('NFC')`, and is stable under lowercasing and NFKC. There is **no length cap**, so long hand-made ASCII folders that are valid today stay valid. Every current slug is still valid.
  - `nameKey(s) = s.normalize('NFC').toUpperCase().toLowerCase()`. It is the comparison key for siblings and reserved names, and matches APFS case folding (verified above).
- Call sites to change:
  - `nodeIdSegments` uses `isNodeName`, with the reserved check on `nameKey`.
  - `readChildren` normalizes `entry.name` to NFC before validating and building ids (HFS+ or external tools may return NFD). It skips a second entry with the same `nameKey` (NFC/NFD twins on Linux) and logs it.
  - `createNode`/`renameNode` use `toNodeName`. A side effect: Cyrillic renames start working; today `Привет` becomes `node`.
  - `moveNodes` `names` uses `isNodeName`.
  - `DELETED_NAME_RE` becomes `^(?<name>NODE_NAME)\.deleted-(?<ts>\d{13,})(?:-(?<n>[2-9]|[1-9]\d+))?$/u`. `\d` stays ASCII under `u`. The `.` keeps trash folders non-names, and `-2` suffixes keep working.
- `fs-utils`:
  - `pickName`, `takenNames` and `claims` compare by `nameKey`.
  - In `createNode`/`renameClaimed`, an `EEXIST`/`ENOTEMPTY` adds the candidate to a per-call `failed` set, so the next attempt moves on to `-2`. Today a fold collision the set misses (for example `λόγοσ` vs `λόγος`) would retry the same name 10 times and then throw.
- Zod schemas:
  - `nodeId = z.string().normalize('NFC').max(1000)`.
  - The trash-id schema and the keys of the move `names` record get the same treatment.
  - Ids only travel in query strings and bodies, which Fastify already decodes. Question ids in paths are UUIDs (`z.uuid()`).
- Unaffected:
  - The agent: the trash guard and `DELETED_PATH_GLOB` key on the ASCII `.deleted-` marker, and the tools accept Unicode paths.
  - File headers: they only carry ASCII attachment and file names.
  - `localeCompare` is only a tie-break in sibling sort. Use a fixed `Intl.Collator('und')` if deterministic order across machines matters.

### 4.7 Extension points kept open
- **Multi-tab.** The registry has no per-connection owner. The stream is app-wide and every mutation is broadcast. `context` is data, not ownership. Many subscribers per question come for free. Across many tabs the HTTP/1.1 pool still allows about 5 streams. A later web-side `BroadcastChannel` leader tab could share one connection.
- **Notifications.** `question` events with `status: 'done' | 'failed'` carry `tree`, `title`, `nodeId`/`error`. Because the stream is app-wide, they also arrive for trees the user is not viewing.
- **Policy seams.** `TreeLocks.acquire*` and `registry.start()` are where a cap or queue would go (non-goal). The global `seq` ids are the seam for Last-Event-ID replay. The registry interface could later be backed by a journal for restart survival (non-goal).

### 4.8 Test strategy and impact on existing tests
- **New tests.**
  - Registry unit tests with no HTTP: snapshot+subscribe atomicity, offsets and attempts, cancel before and during commit, retry, remap/dropUnder/renameTree, retention with `vi.useFakeTimers()`, eviction.
  - Route tests with `inject`: 202, list, detail, DELETE, retry, 409 details.
  - A few stream tests with `listen` + `fetch` + an incremental SSE reader helper (with abort).
  - Shutdown: `app.close()` resolves with open streams and running jobs.
- **Helpers.** `makeApp` returns `questions`. Add `startQuestion()` + `ctx.questions.settled(id)` to replace parsing a whole SSE body.
- **`messages-api.test.ts` / `message-files-api.test.ts`** (about 40 tests):
  - Port them to `POST /questions` + `settled`. Validation and upload tests keep their JSON assertions.
  - The disconnect tests flip meaning: a disconnect after 202 now creates the node. A disconnect during upload still writes nothing and creates no entry.
  - `nameCalls[0]` assertions add `answer`.
- **`agent.test.ts`.** `sanitizeNodeName('Привет')` -> `привет`. Add cases: Devanagari marks, CJK, Final_Sigma, `İ`, ZWJ, emoji -> fallback, byte cap, astral characters at the cut, Unicode `fallbackNodeName`.
- **`storage.test.ts`.**
  - `toKebabCase('Привет') -> 'node'` stays, because it is now tree-only.
  - Add tests for `toNodeName`/`isNodeName`/`nameKey`.
  - Add Unicode `DELETED_NAME_RE`/`parseTrashId` cases. `A.deleted-…` stays invalid.
  - Fold collisions in `createNode` (`straße`/`strasse`, `λόγος`/`λόγοσ` -> `-2`).
  - NFD id -> 400 at the storage layer and normalized at the route.
- **`nodes-api.test.ts`.** 409 `details.questions`. Failed entries remapped after a move and dropped after a delete.

## 5. Risks
- **Runaway cost and lock starvation.** A forgotten question keeps running after the client leaves, which is the intent here, and holds the shared lock, blocking moves. Mitigations: explicit cancel, 409 details naming the blockers, the optional watchdog.
- **The 6-connection HTTP/1.1 pool.** Any design that keeps one SSE per question open in the browser starves `/api`, including attachment images. A3 avoids this. The web must not open extra per-question streams.
- **Vite proxy and SSE.** The existing POST-SSE already works through the proxy. Verify manually that heartbeats pass and that closing the tab closes the upstream connection.
- **Fastify close hangs** if hijacked SSE replies are not ended in `preClose`. Tests would hang in `ctx.close()`.
- **Cancel/commit race.** Once `createNode` starts it cannot be undone, hence the `committing` flag and the `question_finished` 409.
- **Memory.** In-memory text per running or failed question, bounded by the retention caps and by dropping text at commit.
- **Restart.** The registry is lost (accepted non-goal). Staging folders under parents are swept after 1 h by the existing sweep. Held files are swept at startup.
- **Cross-question leakage.** With parallel answers, one question's agent can Glob or Read another question's `.tmp-answer-*/files`. This already happens since side-chat, but parallel questions are now the normal case. Follow-up: extend the PreToolUse trash guard to deny `.tmp-answer-*` segments other than the current staging folder.
- **Naming latency and language.**
  - Naming is now sequential, adding about 1-3 s per answer for the SDK process spawn. The UI must show `naming` with the full answer already visible.
  - Code-heavy answers can skew the language, which is why the excerpt drops code.
  - Mixed-language trees get mixed-script siblings; that is accepted.
- **Unicode filesystem edge cases.**
  - Case-insensitive APFS folds `ß`/`ss`, `ς`/`σ`, `ﬁ`/`fi` (handled by `nameKey` plus advancing on `EEXIST`).
  - On Linux (normalization-sensitive), an NFD folder copied from elsewhere would not resolve by its NFC id. Otago and git on macOS (`core.precomposeunicode`) write NFC, so this is rare. Document it, and add a resolver fallback that scans the parent directory only if it ever matters.
  - macOS PATH_MAX of 1024 bytes in deep multibyte trees: this already applies to ASCII, but each Cyrillic character takes 2 bytes. A user-visible `ENAMETOOLONG` mapping may be worth adding.
  - Homoglyph siblings (Latin `a` vs Cyrillic `а`) are allowed and look identical. That is acceptable for a single local user.
  - `İ` lowercases to `i̇` (with a combining dot), which is correct under locale-independent rules but surprising for Turkish.
- **Web contract change.** The web researcher and planner must adopt 202 plus the event stream. `url-state.ts` already uses `URLSearchParams`, which encodes Unicode correctly. Its `%2F` -> `/` cosmetic replacement is unaffected. I found no ASCII-only id regexes in `web/src`.

## 6. References
- Fastify Hooks, `preClose` for SSE/WebSocket shutdown: https://fastify.dev/docs/latest/Reference/Hooks/ ; Lifecycle (hijack skips the remaining steps): https://fastify.dev/docs/latest/Reference/Lifecycle/ ; `forceCloseConnections` default `"idle"`: `node_modules/fastify/docs/Reference/Server.md`
- `@fastify/sse` README (heartbeat, `replay(lastEventId)`, backpressure): https://cdn.jsdelivr.net/npm/@fastify/sse@0.6.0/README.md
- WHATWG HTML, Server-sent events (`id`, `retry`, Last-Event-ID, comment keep-alive): https://html.spec.whatwg.org/dev/server-sent-events.html
- MDN EventSource (6-connection limit without HTTP/2, "won't fix"): https://developer.mozilla.org/en-US/docs/Web/API/EventSource ; "The Pitfalls of EventSource over HTTP/1.1": https://textslashplain.com/2019/12/04/the-pitfalls-of-eventsource-over-http-1-1/
- Vite server options (`server.https` falls back to TLS only, without HTTP/2, when `server.proxy` is used): https://vite.dev/config/server-options
- AI SDK "Chatbot Resume Streams" (decoupling generation from the request; why abort-on-disconnect conflicts with resume): https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
- Node.js backpressure in streams: https://nodejs.org/en/learn/modules/backpressuring-in-streams
- APFS normalization (insensitive and preserving vs HFS+ NFD): https://eclecticlight.co/2017/04/06/apfs-is-currently-unusable-with-most-non-english-languages/ ; https://eclecticlight.co/2024/03/25/apfs-directories-and-names/ ; Git `t/lib-unicode-nfc-nfd.sh` notes on APFS: https://git.lorimer.id.au/gitweb.git/diff/742ae10e355041bb19b8d3d530453136e2a8eff2
- File name and path limits (NAME_MAX 255, PATH_MAX 1024 on macOS): https://developer.apple.com/forums/thread/726970 ; https://doc.owncloud.com/server/admin_manual/troubleshooting/path_filename_length.html
- MDN `toLocaleLowerCase` (default vs locale case mapping, Turkish): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/toLocaleLowerCase ; esdiscuss "Locale sensitivity in toLowerCase": https://esdiscuss.org/topic/locale-sensitivity-in-tolowercase-touppercase
- Unicode UAX #15 (normalization forms), https://www.unicode.org/reports/tr15/ ; UAX #31 (identifier syntax, NFKC for identifiers), https://www.unicode.org/reports/tr31/ ; MDN `Intl.Segmenter`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
- Zod 4 string transforms (`.normalize()`): https://zod.dev/api#strings
