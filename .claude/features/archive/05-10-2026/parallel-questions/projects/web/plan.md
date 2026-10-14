# parallel-questions — web plan (`@otago/web`)

Client plan. Source of truth for shapes: `.claude/features/parallel-questions/contracts/`
(`questions.ts`, `questions-api.ts`, `question-events.ts`, `errors.ts`, `lifecycle.ts`,
`node-names.ts`, `shared.ts`). Nothing here changes the contract. There is no codegen: the web
mirrors the shapes by hand in `web/src/api/types.ts`. There is nothing to regenerate.

Lockstep: the server deletes `POST /api/trees/:tree/messages` (server plan step 6). Web steps 1–5
are pure, so they can land earlier. Web step 6 (switching the panels to the questions API) must
land in the same change as server step 6.

Formatting: never hand-format. After each step run `pnpm check` (or `pnpm format`), then
`pnpm lint` and `pnpm --filter @otago/web test`. No new dependencies: no zustand, and no
EventSource or its polyfill.

## Contract issues

**None that block the client.** Three points are interpretations the client relies on. They are
non-blocking and recorded here so the server owner can confirm them:

1. **"Upsert by id" for 202 bodies.** `questions.ts` says every 202 and every `question` event
   carries the full object and that clients "replace their copy by id". Applied literally to a
   202, that can **regress** state. If the SSE `done`/`failed` for a fast question arrives before
   its 202 (different connections), replacing it with the 202 copy would set it back to
   `streaming`. The client therefore applies HTTP copies only when the id is unknown or the
   `attempt` is higher (and never for ids removed recently). SSE `question` events always
   replace. A monotonic `version` field would make this exact, but it is not required.
2. **Abort right at registration.** If the user aborts the upload in the moment between server
   step 6 (register) and the 202 arriving, the question is already registered but the client
   never got its id from the response. It still arrives through SSE as a normal pending node and
   can be cancelled from the graph. A `clientRequestId` echo would allow an automatic cancel;
   v1 accepts the race.
3. **Seeded `ChainNode.created`.** A done question does not carry the node's `created`. The
   optimistic chain seed uses `question.updatedAt`, and the refetch then replaces it (same as
   today's `new Date()`).

## Resolved open questions (feature.md, client side)

| Question | Decision |
|---|---|
| API shape | Server-owned (202 start + one app-wide SSE). Client: **one `fetch` + `readSse` reconnect loop per tab** (not `EventSource`). It survives the Vite proxy's 502 on server restarts and has a 45 s watchdog (3 missed pings). It disconnects after 30 s in a hidden tab (shared HTTP/1.1 pool) and resyncs on visible/online. |
| Retention | Server-owned. Client: a `done` question stays until the tree refetch shows its node. Then it is **acked** locally: its text and local `File`s are released and its graph box disappears. Failed entries stay until Dismiss/Retry or `removed`. Removed ids are kept as **tombstones** (last 500), so late 202s cannot bring them back. |
| Follow-up under a pending node | **No.** While a panel's focus is a pending or failed question, its composer is locked (Send disabled). "Ask aside" is disabled while the main focus is a question. A pending node has no id. |
| Unicode slug rules / URL encoding | Server-owned. Client: `readUrlState` normalizes `node`, `side` and `sideNode` to **NFC**. Writing keeps `URLSearchParams` (percent-encoded UTF-8) plus the cosmetic `%2F` → `/`. The client never generates folder names. Ids are displayed with `dir="auto"` / `<bdi>`, and every truncation is grapheme-safe (`Intl.Segmenter`). |
| Naming input | Server-only. Client: status `naming` shows "Saving…", the complete answer and no caret. |
| Pending title | `question.title` (server: first line, ≤ 80 graphemes, file names for file-only messages), cut again to **40 graphemes + `…`** for the one-line box. The tooltip shows ≤ 200 graphemes of the text plus the status. |
| Cancel affordances | Composer **Cancel** (streaming, or upload abort). **Esc twice** on a focused running box (the first press arms a 2 s "Esc again to cancel" hint). **Cancel** / **Cancel all** in the blockers dialog. **No cancel while `naming`** anywhere in the UI: the answer is complete, cancelling would discard it, and it finishes within ≤ 30 s (the server would allow it). |
| Failed upload | Server: never creates an entry. Client: the outbox entry turns "Not sent" inline, and the draft and files go back to the composer. If that panel is gone, the draft goes to the per-chat draft stash and a notice is shown. |
| Side backgrounding | URL carries only the foreground aside (`side`, `sideNode`, `sideQ`). A backgrounded aside is reachable only through its pending/failed box, and after completion through its created node (opens in the main chat, as today). |
| Type-ahead in a locked composer | No. The textarea stays disabled, as today. Possible follow-up. |
| Store technology | Hand-rolled external store + pure reducer + `useSyncExternalStore` (research S2). |

## Architecture (new modules)

```
web/src/lib/text.ts               grapheme helpers (Intl.Segmenter), firstLine, collapseWhitespace
web/src/lib/questions.ts          PURE: state, reducer, HTTP-merge rule, lifecycle diff, local
                                  remaps, selectors + equality, pending labels, in-flight view
web/src/lib/question-store.ts     store (current vs published state, rAF-coalesced notify,
                                  lifecycle channel, ask/cancel/retry/dismiss), context, hooks
web/src/lib/question-sync.ts      glue: connection ⇄ store, visibility/online policy, unconfirmed expiry
web/src/lib/question-focus.ts     PURE: URL focus rules (reconcile, accepted 202, open box, ask aside)
web/src/lib/blockers.ts           PURE: TreeBusyDetails reader, blocker list merge
web/src/lib/draft-stash.ts        in-memory per-chat draft stash (text + ComposerFile[])
web/src/lib/notices.ts            tiny external store of transient notices (+ pure list ops)
web/src/api/question-events.ts    SSE event parsing + fetch reconnect loop with watchdog/backoff
web/src/components/QuestionEffects.tsx      App-level side effects of lifecycle events + URL reconcile
web/src/components/chat/useComposer.ts      composer state (replaces useChatSession.ts)
web/src/components/chat/useInFlight.ts      panel's in-flight exchange (focus or outbox) + actions
web/src/components/chat/InFlightExchange.tsx  rendering of an in-flight/failed exchange
web/src/components/graph/BlockersDialog.tsx + blockers-context.ts
web/src/components/ui/IdPath.tsx            bidi-safe id rendering (<bdi> per segment)
web/src/components/ui/Notices.tsx           notice stack (aria-live)
```

Data flow: server SSE → `question-events` loop → `store.receive(event)` → pure `reduce` → `current`
state (+ lifecycle events, emitted synchronously) → published to React once per animation frame →
hooks with cached selectors. Panels send through `store.ask()` (an outbox entry until the 202). URL =
which question each panel shows (`q`, `sideQ`).

## Data model (client state, `lib/questions.ts`)

```ts
type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'paused';
interface QuestionStream { attempt: number; text: string; attachments: StreamingAttachment[] }
interface OutboxEntry {
  id: string;                        // local id `out-<n>`; also the stable graph box key
  tree: string; parentId: string; context: QuestionContext; stashKey: string;
  text: string; files: ComposerFile[]; model?: string; namingModel?: string;
  phase: 'sending' | 'uploading'; error: unknown | null; createdAt: string;
}
interface QuestionsState {
  instance: string | null; hydrated: boolean; snapshotCount: number; connection: ConnectionStatus;
  questions: Record<QuestionId, QuestionInfo>;        // meta of every tree
  streams: Record<QuestionId, QuestionStream>;        // live text, only for non-acked entries
  outbox: Record<string, OutboxEntry>;
  localKeys: Record<QuestionId, string>;              // id → outbox id (stable box key after 202)
  localFiles: Record<QuestionId, ComposerFile[]>;     // File objects of questions sent by this tab
  cancelling: Record<QuestionId, true>;               // DELETE in flight from this tab
  acked: Record<QuestionId, true>;                    // done + tree refetched (or first seen as done)
  unconfirmed: Record<QuestionId, number>;            // inserted from a 202, not yet seen on the stream
  tombstones: QuestionId[];                           // last 500 removed ids
}
```
`AbortController`s of the outbox live in the store's private map, not in state.

## Implementation steps (in order; each step keeps lint and tests green)

### Step 1 — Foundations: types, client, SSE parser, errors, text helpers (pure)

`web/src/api/types.ts` (change). Header: add `.claude/features/parallel-questions/contracts`.
- Add mirrors: `QuestionId`, `QuestionStatus`, `RunningQuestionStatus`, `QuestionContext`,
  `QuestionFailureCode`, `QuestionError`, `RunningQuestion`, `DoneQuestion`, `FailedQuestion`,
  `QuestionInfo`, `QuestionLive`, `QuestionDetail`, `StartQuestionPayload` (parentId, text?, model?,
  namingModel?, context?), `StartQuestionResponse`, `RetryQuestionResponse`, `SnapshotEventData`,
  `QuestionEventData`, `ChunkEventData`, `AttachmentEventData`, `QuestionRemovedReason`,
  `RemovedEventData`, `QuestionStreamEvent`, `QuestionErrorCode`, `BlockingQuestion`,
  `TreeBusyDetails`, `QuestionFinishedDetails`.
- `ErrorBody.code` += `QuestionErrorCode`. Update the `details` doc (no longer 400-only).
- Remove `MessageDone` and `MessagePayload` (replaced by `StartQuestionPayload`).
- `ChainNode`/`HierarchyNode` doc: ids may contain Unicode letters (NFC on the wire).

`web/src/api/client.ts` (change)
- `ApiError` gets a 4th constructor field `readonly details?: unknown`. `errorOf` keeps
  `body.details` for every status.
- `ApiErrorCode` += `QuestionErrorCode`. New whitelist `QUESTION_ERROR_CODES`
  (`question_not_found`, `question_finished`, `question_not_failed`) in `isErrorCode`.
- `buildMessageBody` → `buildQuestionBody(input: { parentId, text, model?, namingModel?, context,
  files? })`. Same JSON/multipart rules, plus `context` in the JSON body and in `payload`.
- `api.startQuestion(treeId, input, signal?)` → `POST /trees/:tree/questions` (202) →
  `Promise<QuestionInfo>`. It passes `signal` and the built headers to `request`, so upload aborts
  work.
- `api.cancelQuestion(id)` → `DELETE /questions/:id` (204). `api.retryQuestion(id)` →
  `POST /questions/:id/retry` (no body) → `Promise<QuestionInfo>`. Ids go through `encodeURIComponent`.
- Delete `sendMessage`, `SendMessageInput`, `MessageBodyInput` and `STREAM_EVENTS`. Drop the
  `readSse` import (it moves to `question-events.ts`). Drop `i18n` if unused.
- Not added (YAGNI, the endpoints exist): `GET /api/questions`, `GET /api/questions/:id`.

`web/src/api/sse.ts` (change)
- `SseEvent` gains `id?: string` (the `id:` field; ignored when it contains NUL, per WHATWG).
- `readSse(body, options?: { onBytes?: () => void })`: calls `onBytes` after every read with
  bytes. Comments (`: ping`) count as bytes, and the watchdog relies on that.

`web/src/lib/text.ts` (create)
- Module-level `Intl.Segmenter(undefined, { granularity: 'grapheme' })`.
- `graphemes(s)`, `truncateGraphemes(s, max, ellipsis = '…')`: returns `s` unchanged if it fits.
  Never doubles an ellipsis already at the cut. Never uses `slice`.
- `firstLine(s)`: first non-empty trimmed line. `collapseWhitespace(s)`.

`web/src/lib/chat-errors.ts` (change)
- `tree_busy_streaming`: the message uses `TreeBusyDetails` when present
  (`errors.busyStreamingCount`, count = `questions.length + preparing`), else the old text.
- 404 `parent_not_found` → kind `node-missing`, message `errors.parentMissing`. The side panel's
  close button then also works for a deleted anchor/head on send.
- 404 `question_not_found` → `errors.questionNotFound`. 409 `question_finished` →
  `errors.questionFinished`.
- New `describeQuestionFailure(error: QuestionError): string` → `chat:failure.<code>` with
  `{ message }`.

`web/src/lib/chat-files.ts` (change, comments only): constants now mirror
`parallel-questions/contracts/questions-api.ts` (`MESSAGE_PAYLOAD_FIELD`, `MESSAGE_FILES_FIELD`
unchanged).

### Step 2 — URL state: `q`, `sideQ`, NFC (pure)

`web/src/lib/url-state.ts` (change)
- `UrlState.question: string | null` (`?q=`, main-chat focus). `SideChatState.question: string |
  null` (`?sideQ=`, foreground-aside focus).
- `readUrlState`:
  - `node`, `side` and `sideNode` are passed through `.normalize('NFC')` before validation.
  - `q` is read only with a tree. `sideQ` is read only with a side. Empty → null.
  - Keep the "first entry only" list seam.
- `writeUrlState` order: `tree, node, q, side, sideNode, sideQ`. `q` only with a tree, `sideQ`
  only with a side. `URLSearchParams` + `%2F` → `/` unchanged.
- `mergeUrlState`:
  - A tree switch also resets `question` unless it is given.
  - **A `node` change resets `question` unless `question` is given.** This is the safe default:
    selecting a node leaves the pending focus.
- `openSide` → `{ anchor, head: null, question: null }`. `promoteSide` → `null` unless
  `head !== null && question === null`; otherwise `{ node: head, question: null, side: null }`.
- `followTreeRename` carries `question` (and `side.question`) explicitly.
- `remapSideAfterMove/Delete` preserve `question` (question ids never change).
- **Delete `advanceSide`** (completion is handled by `reconcileFocus`, step 5). Port its tests.

`web/src/lib/side-chat.ts` (change): `canPromote(side)` = `side.head !== null && side.question
=== null` (the `streaming` parameter is gone).

### Step 3 — Questions core (pure) `web/src/lib/questions.ts` (create)

**Reducer** `reduce(state, action, now): { state; lifecycle: LifecycleEvent[]; resync: boolean }`.
It returns the **same `state` object** when nothing changed. Actions:
- `event` (`QuestionStreamEvent` from the stream):
  - `snapshot` is authoritative.
    - Replace `questions` with the snapshot entries.
    - Streams: set from `live` (`{ attempt, text: live.answer, attachments: reduce
      live.attachments with applyAttachmentEvent }`). For `done` (`live: null`), keep the local
      stream if present.
    - Entries missing from the snapshot are removed with lifecycle `removed`. The reason is
      `'restart'` if `instance` changed, else `'missing'`. **Exception:** `unconfirmed` entries
      are kept (their `question` event may still be on the way).
    - Done entries not known before get `acked` (nothing to wait for).
    - Set `instance`, `hydrated = true`, `snapshotCount + 1`.
  - `question`:
    - Ignore tombstoned ids.
    - Replace the entry (full object, ordered per connection) and clear `unconfirmed[id]`.
    - If `attempt > stream.attempt`, reset the stream to `''`/`[]`.
    - Lifecycle: `added`, `naming`, `done`, `failed`, `retried` (attempt grew), `moved`
      (`parentId`/`context`/`tree`/`nodeId` changed).
  - `chunk` (contract rule):
    - Drop it for an unknown id or an older attempt. Reset the stream on a newer attempt.
    - If `offset > text.length`, it is a **gap**: state is unchanged and `resync: true`.
    - Otherwise append `text.slice(text.length - offset)`. An empty tail returns the same state.
  - `attachment`: dropped on an attempt mismatch; otherwise `applyAttachmentEvent` on the stream.
  - `removed`:
    - Delete the id from `questions`, `streams`, `localKeys`, `localFiles`, `cancelling`, `acked`
      and `unconfirmed`. Push it to `tombstones` (cap 500).
    - Lifecycle `removed{ reason, nodeId, question, local: !!cancelling[id] }`.
- `connection(status)`.
- `outbox/add(entry)`, `outbox/accepted(outboxId, question)`, `outbox/failed(outboxId, error)`,
  `outbox/drop(outboxId)`.
  - `accepted` moves `files` → `localFiles[question.id]`, sets `localKeys[question.id] =
    outboxId` and deletes the outbox entry.
  - It then applies the **HTTP-merge rule**: insert if unknown and not tombstoned (mark
    `unconfirmed[id] = now`); replace only if `question.attempt > local.attempt`; else ignore.
  - Lifecycle `accepted{ question, outboxId, entry }`.
- `http/question(question)` (retry 202): the same HTTP-merge rule.
- `cancel/start(id)`, `cancel/end(id)`, `local/removed(id, reason)` (after a 204/404 of this
  tab's DELETE; idempotent with the SSE `removed`, `local: true`), `ack(id)`.
  - `ack` sets `acked`, drops `streams[id]` and `localFiles[id]`.
- `local/remap(tree, map)`, `local/dropUnder(tree, ids)`, `local/renameTree(from, to)` mirror
  the server's rules for **retained** (failed/done) entries. This avoids a transient URL fight
  before the server's `question`/`removed` events arrive.
  - Prefix remap of `parentId`, `context.anchor` and done `nodeId` via `afterMove` (tree.ts).
  - If a side anchor is no longer ancestor-or-self of `parentId`, set `anchor = parentId`.
  - `dropUnder`: `parentId` (or done `nodeId`) same as or inside a deleted id → removed (`local`).
  - Running entries are untouched (they hold the lock).
- `expireUnconfirmed(now, graceMs)`: entries unconfirmed for longer than `graceMs` → removed
  (`reason: 'missing'`).

**Lifecycle events**
- Shape: `{ type: 'added' | 'accepted' | 'naming' | 'done' | 'failed' | 'retried' | 'moved' |
  'removed' | 'outbox-ended'; …; source: 'live' | 'resync' | 'local' }`.
- `snapshot` diffs use `resync`, local actions use `local`, and SSE deltas use `live`.
- This is the hook point for notifications and multi-tab later.

**Selectors** (pure; each with an equality function used by the hook cache):
- `selectTreeQuestions(state, tree)`: meta sorted by `createdAt`.
- `selectPendingBoxes(state, tree)`: `PendingBox[] = { key, questionId | null, outboxId | null,
  parentId, context, label, createdAt, nodeId | null }`.
  - Covers running/failed questions, done-but-not-acked questions, and outbox entries without
    an error.
  - `key = localKeys[id] ?? id` (outbox id for questions this tab sent), so the box keeps its
    flow id across the 202.
  - Equality: same keys, parentIds, labels and nodeIds. **Chunks and status changes do not
    change it.**
- `selectPendingStatuses(state, tree)`: `Record<key, { questionId, outboxId, status:
  PendingStatus, tooltip, error?: string }>`.
  - `PendingStatus = 'sending' | 'uploading' | 'streaming' | 'naming' | 'done' | 'failed' |
    'cancelling'`.
  - Shallow equality per key.
- `selectIsTreeBusy(state, tree)`: `streaming`/`naming` questions or non-errored outbox entries of
  the tree.
- `selectTreeCounts(state)`: `Record<tree, { running, failed }>`.
- `selectQuestionView(state, id)`: `{ info, stream, localFiles, cancelling, acked } | null`
  (equality by reference per field).
- `selectOutboxFor(state, tree, context, parentId)`: the newest matching outbox entry.
- `pendingLabel(title, max = 40)` and `pendingTooltip(text, fileNames)` via `lib/text.ts`.

**In-flight view** (pure, for the panels):
- `type InFlightView = { kind: 'outbox'; entry } | { kind: 'question'; info; stream;
  localFiles; cancelling } | { kind: 'loading'; id }`.
- `inFlightStatus(view)` → `'sending' | 'uploading' | 'answering' | 'saving' | 'cancelling' |
  'failed' | 'not-sent' | 'loading'`. Mapping: `naming`/`done` → `saving`; an outbox error →
  `not-sent`.
- `inFlightCanCancel(view)`: outbox (not errored) or `streaming` and not cancelling.

**Cached selector helper** `createCachedSelector(select, equal)`. It returns the previous
value while `equal(prev, next)`, and the same value for the same state object. The hooks use it,
and it is the unit under the identity tests.

### Step 4 — Connection loop and store

`web/src/api/question-events.ts` (create)
- `QUESTION_EVENTS_URL = '/api/questions/events'`.
- `QUESTION_EVENTS_WATCHDOG_MS = 3 * 15_000` (3 × `SSE_PING_INTERVAL_MS` of the contract).
- `parseQuestionEvent(sse: SseEvent): QuestionStreamEvent | null`:
  - Unknown event names → `null` (forward compatible, e.g. `tree_changed`).
  - Known names with bad JSON or a bad shape → throws `QuestionProtocolError` (minimal guards:
    string ids, numeric `attempt`/`offset`, string `text`, array `questions`).
- `nextBackoff(attempt, { initialMs = 500, maxMs = 10_000 }, random)`: exponential with full
  jitter, capped. Pure.
- `createQuestionConnection({ onEvent, onStatus, fetch = globalThis.fetch, url, watchdogMs,
  backoff, random })` → `{ start(), stop(), resync() }`.
  1. `fetch(url, { signal, headers: { accept: 'text/event-stream' }, cache: 'no-store' })`.
  2. Anything except 200 + `text/event-stream` + body → failure. This includes the Vite proxy's
     502 `text/plain`.
  3. Read with `readSse(body, { onBytes: armWatchdog })`. The watchdog aborts after `watchdogMs`
     of silence.
  4. Status `live` only after the `snapshot` event, which also resets the backoff. A first event
     other than `snapshot` is a protocol error.
  5. A protocol error, end of stream or network error leads to `reconnecting` + backoff sleep.
     The sleep can be interrupted by `stop()`/`resync()`.
  6. `resync()` aborts the current fetch and reconnects **immediately**. `stop()` → `paused`, no
     reconnect, until `start()`.
- `retry:` and `id:` are ignored (the contract allows it; v1 resyncs by snapshot).

`web/src/lib/question-store.ts` (create)
- `createQuestionStore({ api, now = Date.now, schedule })` → `QuestionStore`:
  - `getState()` (**current**, updated per action; for imperative code and lifecycle listeners).
  - `getSnapshot()` (**published**, copied at flush; for React).
  - `subscribe(listener)`: render listeners, notified once per flush.
  - `onLifecycle(listener)`: synchronous, every event in order.
  - `schedule` default: `requestAnimationFrame` when visible, `setTimeout(…, 100)` when
    `document.hidden`. Tests pass a manual flush.
  - `receive(event): { resync: boolean }`, `setConnection(status)`.
  - `ask({ tree, parentId, context, stashKey, text, files, model?, namingModel? }): string`:
    - Adds the outbox entry (`uploading` with files, else `sending`) and calls
      `api.startQuestion` with an `AbortController`.
    - 202 → `outbox/accepted`.
    - Abort → `outbox-ended{ outcome: 'aborted' }`.
    - Error → `outbox/failed`.
    - Before delivering the outcome, the store asks the claim handler (below). If no handler is
      registered, or it returns `false`, the store drops the entry and emits `outbox-ended{
      shown: false, entry, error }`.
  - `claimOutbox(outboxId, onEnd: (end) => boolean): () => void`. The sending composer
    registers `onEnd`, restores the draft/files, and returns whether its panel shows the entry
    inline.
  - `abortOutbox(outboxId)`, `dropOutbox(outboxId)`.
  - `cancel(id): Promise<void>`:
    - `cancel/start` → `api.cancelQuestion`.
    - 204 / 404 `question_not_found` → `local/removed(cancelled)`.
    - 409 `question_finished` → only `cancel/end` (the SSE `done` was emitted before the 409;
      ordering guarantee 5 + DELETE semantics).
    - Other errors → `cancel/end` and rethrow.
  - `dismiss(id)`: the same DELETE. 204/404 → `local/removed(dismissed)`.
  - `retry(id): Promise<void>`: `api.retryQuestion` → `http/question`. 404
    `question_not_found` → `local/removed`. Other errors are rethrown (shown inline by the panel).
  - `ack(id)`, `applyLocal(change)`, `expireUnconfirmed(now)`.
- `QuestionStoreContext` + `useQuestionStore()`.
- `useStoreSelector(select, equal, deps)`: `useSyncExternalStore(store.subscribe,
  cachedGetSnapshot)`, with the cached getter rebuilt per `deps` (`createCachedSelector`).
- Hooks: `useQuestionView(id | null)`, `useOutboxFor(tree, context, parentId)`,
  `useTreeBusy(tree)`, `usePendingBoxes(tree)`, `usePendingStatuses(tree)`, `useTreeCounts()`,
  `useConnectionStatus()`, `useHydrated()`.
- The graph never subscribes to text. Only the focused panels do, through `useQuestionView`.

`web/src/lib/question-sync.ts` (create)
- `startQuestionSync(store, { connection = createQuestionConnection(…), hiddenDisconnectMs =
  30_000, unconfirmedGraceMs = 10_000, doc = document, win = window }) → stop()`:
  - `onEvent` → `store.receive`. A `resync` result → `connection.resync()`.
  - `onStatus` → `store.setConnection`.
  - `visibilitychange`: hidden → timer → `connection.stop()`. Visible → clear the timer, and
    `start()` if paused.
  - `online` → `resync()` when not live.
  - Every 5 s while live → `store.expireUnconfirmed(now, grace)`.
  - Extension seam: `hiddenDisconnectMs: null` keeps hidden tabs connected (future
    notifications); `connection` is injectable (future leader tab / BroadcastChannel follower).

`web/src/main.tsx` (change)
- Create `questionStore = createQuestionStore({ api })` and `stopSync =
  startQuestionSync(questionStore)` outside React, next to the `QueryClient`. This way
  StrictMode cannot open two streams.
- `import.meta.hot?.dispose(stopSync)`.
- Wrap `<App />` in `<QuestionStoreContext.Provider value={questionStore}>`.

### Step 5 — Focus, blockers, draft stash, notices (pure + tiny stores)

`web/src/lib/question-focus.ts` (create). Every function is pure, and its result is idempotent
once applied.
- `reconcileFocus(url, state): Partial<UrlState> | null`. It runs only when `state.hydrated`, or
  when the focused id is already known.
  - **Main** `q`:
    - Unknown (not in `questions`, not unconfirmed) → `{ question: null }`.
    - `tree !== url.tree` → `{ question: null }`.
    - `done` and acked → `{ node: nodeId, question: null }`.
    - `url.node !== parentId` → `{ node: parentId, question: q }`.
  - **Side** `sideQ`:
    - Unknown, other tree, or not a `side` context → `{ side: { …side, question: null } }`.
    - `done` and acked → `{ side: { anchor, head: nodeId if it is a valid head else side.head,
      question: null } }`.
    - Anchor/head mismatch with `context.anchor`/`parentId` → `{ side: { anchor: ctx.anchor,
      head: parentId === anchor ? null : parentId, question } }`.
  - The main and side patches are merged.
- `acceptedFocus(url, question): Partial<UrlState> | null` (on 202, against the **live** URL).
  - Main: same tree, `url.node === parentId` and `url.question === null` → `{ question: id }`.
  - Side: same tree, same anchor, `sideParent(side) === parentId` and `side.question === null`
    → `{ side: { …side, question: id } }`.
  - Otherwise `null`: the question only appears in the graph.
- `openPendingTarget(box, state): Partial<UrlState> | null`.
  - Question, main → `{ node: parentId, question: id }`.
  - Question, side → `{ side: { anchor, head: parentId === anchor ? null : parentId, question:
    id } }`.
  - Outbox entries → the same with `question: null`.
- `askAsideTarget(url): Partial<UrlState> | null | 'disabled'`.
  - `'disabled'` when `url.question !== null`.
  - Reuse (`null`) when `side.anchor === url.node && side.question === null`.
  - Else `openSide(url, url.node)`.
- `focusedIn(url, id): 'main' | 'side' | null`.

`web/src/lib/blockers.ts` (create)
- `treeBusyDetailsOf(error): TreeBusyDetails | null`. Requires an `ApiError` 409 with code
  `tree_busy_streaming` and validated `details`; malformed items are filtered out.
  `finishedNodeIdOf(error): string | null`.
- `blockerList(state, tree, opened: { details: TreeBusyDetails | null; snapshotCount: number })
  → { items: BlockerItem[]; preparing: number; uploading: number }`.
  - Items: the store's running questions of the tree (`cancelling` flag), plus `details`
    questions unknown to the store.
  - Server-only items are dropped when tombstoned, when the store knows them as non-running, or
    when a newer snapshot arrived since opening (`state.snapshotCount > opened.snapshotCount`).
  - `preparing` comes from `details` (informational). `uploading` = live outbox count of the tree.
  - `BlockerItem = { id, title, parentId, context, status, cancelling, source }`.

`web/src/lib/draft-stash.ts` (create)
- In-memory `Map<string, { text: string; files: ComposerFile[] }>`.
- `stashKeyOf(tree, context)` → `${tree}:main` or `${tree}:side:${anchor}`.
- `get(key)`, `set(key, draft | null)` (an empty draft deletes the key).
- `mergeDraft(current, restored)`: keep the current non-empty text; files use `restoreFiles`
  semantics.
- `File` objects never leave memory.

`web/src/lib/notices.ts` (create)
- Pure `addNotice(list, notice)` (dedupe by `key`, cap 3, newest last) and `removeNotice`.
- A module store with `pushNotice`, `dismissNotice`, `subscribe`, `getSnapshot`, and a
  `useNotices()` hook.
- `Notice = { id, kind: 'info' | 'error', message, key? }`.

### Step 6 — Chat panels on the questions API (lockstep with server step 6)

`web/src/components/chat/useComposer.ts` (create; replaces `useChatSession.ts`, which is deleted)
- Options: `{ treeId, stashKey, target: { parentId, context } | null }`. A `null` target locks
  the composer.
- Keeps today's draft, files, file errors, model choice (`otago.models`), quote/appendToDraft and
  the composer ref.
- Initial state comes from `draftStash.get(stashKey)`. On unmount it writes the stash (cleanup
  effect).
- `send()`:
  1. If `canSend(draft, files, locked)`: drop this target's failed outbox entries.
  2. `store.ask({ …target, tree, stashKey, text: draft.trim(), files, model, namingModel })`.
  3. `claimOutbox(id, onEnd)`, clear the draft, files and stash.
  - `onEnd` (aborted or failed): `setDraft(current || text)`, `restoreFiles`, release the claim.
    It returns `true` only for a failure while the target still equals the entry's parent and
    context (the panel shows it inline).
- On unmount it releases claims. In-flight sends continue, and `QuestionEffects` handles their
  end.
- Returns `{ …state, canSend, locked, send }`.

`web/src/components/chat/useInFlight.ts` (create)
- `useInFlight({ treeId, context, parentId, focus }) → { view: InFlightView | null; locked:
  boolean; cancel?; retry; dismiss; dismissOutbox }`.
  - With `focus` → `useQuestionView(focus)`. If it is unknown before hydration → `{ kind:
    'loading' }`.
  - Without `focus` → `useOutboxFor(…)`.
  - `locked` = a view exists, except a `not-sent` outbox entry (the composer stays usable to
    resend).
  - `cancel` is present only when `inFlightCanCancel`: outbox → `abortOutbox`, question →
    `store.cancel`.
  - `retry`/`dismiss` call the store and expose `isPending`/`error` through `useMutation`.

`web/src/components/chat/InFlightExchange.tsx` (create). Pure props, so it can have an SSR smoke
test.
- Renders `Exchange` with:
  - Question: `info.text` or `entry.text`.
  - Answer: `stream.text`. Caret only for `answering`.
  - `AttachmentScope`: `{ nodeId: null, streaming: stream.attachments, unsaved: failed |
    not-sent }`.
  - Files: local `ComposerFile`s when present (thumbnails), else `info.files` names (the
    `staged` variant).
- Meta line: `inFlight.<status>` and the model tag.
- Footer:
  - failed → `ErrorNote(describeQuestionFailure(info.error))` + **Retry** + **Dismiss**, and
    the retry mutation error inline (404 `parent_not_found` → `chat:retryParentMissing`).
  - not-sent → `ErrorNote(describeError(error))` with dismiss → `dropOutbox`, plus the panel's
    `footer(error)` (side close button).
  - cancelling → muted "Cancelling…".

`web/src/components/chat/ChatThread.tsx` (change)
- Props: drop `pending`, `showPending`, `onDismissError`, `pendingFooter` and `errorText`.
- Add `inFlight: InFlightView | null`, `inFlightActions` and `inFlightFooter?: (error) =>
  ReactNode`. Render `<InFlightExchange>` after the messages.
- Scroll effects key on `inFlight` identity (key/id), `stream.text.length`, status and attachment
  count.

`web/src/components/chat/UserFileList.tsx` (change): new variant `{ staged: UserFileInfo[]; status:
'attached' | 'keptForRetry' }`. It shows kind badge, name and size with no fetch (staging is not
served).

`web/src/components/chat/Composer.tsx` (change)
- `streaming` is renamed `locked` (same disabling behavior).
- `onStop` → optional `onCancel`. When locked: show **Cancel** if `onCancel`; otherwise a
  disabled status button with `composerStatus` (`saving` → "Saving…", `cancelling`).
- Target line: `composer.waitingFor` while a running focus is shown, `composer.failedFocus`
  for a failed focus. Otherwise "Reply under" with `<IdPath>` instead of the raw `<code>`.

`web/src/components/chat/ChatView.tsx` (change)
- Props: `tree`, `currentId`, `question` (= `url.question`), `onSelectNode`, `onAskAside` (`null`
  when disabled). Drop `onStreamingChange`, `askAsideEnabled`, the "Answering under X… Show"
  notice and `Trans`.
- `useInFlight({ context: MAIN, parentId: currentId, focus: question })` + `useComposer({
  stashKey: stashKeyOf(tree.id, MAIN), target: locked ? null : { parentId: currentId, context:
  MAIN } })`.
- Crumbs: `dir="auto"`. With a focus, a final muted crumb shows `pendingLabel(title)`.
- Selection actions: "Ask aside" only when `onAskAside` is set.

`web/src/components/chat/SideChatView.tsx` (change)
- Props: `tree`, `side` (with `question`), `seed`, `onSeedConsumed`, `onPromote`, `onClose`.
  Drop `onAdvance` and `onStreamingChange`.
- Context `{ kind: 'side', anchor: side.anchor }`, parent `sideParent(side)`, focus
  `side.question`.
- Promote: `canPromote(side) && !chainMissing`. Title `side.waitAnswer` while `side.question`.
- `onClose` also clears `draftStash` for this anchor. The background question keeps running.
- Side title anchor via `<IdPath>`.
- `inFlightFooter`: close button when `isNodeMissing(error)` (now includes `parent_not_found`).

`web/src/components/QuestionEffects.tsx` (create; rendered once in `App`, returns `null`)
- `store.onLifecycle`, always reading the **live** URL (`readUrlState(location.search)`):
  - `accepted` → `acceptedFocus` → `navigate(patch)` (push).
  - `done`:
    1. Start `invalidateQueries(keys.tree(tree))`.
    2. If the question is focused here and its stream text exists, seed the chain with
       `seedDoneChain(queryClient, info, text)`.
    3. When the invalidation settles, `store.ack(id)`. Not focused → ack after the invalidation
       too; it resolves at once when the tree is not displayed.
  - `removed` with `!local` of a question focused here → `pushNotice`: `notices.<reason>`
    (`cancelled` → elsewhere, `dismissed` → elsewhere, `expired`, `deleted` → parentDeleted,
    `missing` → vanished).
  - `removed` with `restart` → one aggregated `notices.serverRestarted` (count of running
    entries lost).
  - `outbox-ended{ shown: false }` → if failed: `pushNotice(notices.notSent)`. Merge the text and
    files into `draftStash` under `entry.stashKey` (aborted and failed).
- Reconcile: `const patch = useStoreSelector(s => reconcileFocus(url, s), patchEqual, [url])` →
  `useEffect(() => patch && navigate(patch, true))`.

`web/src/api/queries.ts` (change): `seedDoneChain(queryClient, question: DoneQuestion, text)`.
- Uses the cached parent chain (`keys.chain(tree, parentId)`). If that is missing, skip.
- Seeds `keys.chain(tree, nodeId)` with the parent chain plus `{ id: nodeId, name:
  nameOf(nodeId), created: updatedAt, model, user: text, assistant: text.trim(), attachments,
  files }`.

`web/src/App.tsx` (change)
- Remove `mainStreaming`, `sideStreaming`, `advance`, `askAsideEnabled`, `onStreamingChange` and
  the `busy` prop.
- `setCurrent(node)` → `navigate({ node, question: null })`.
- `onCurrentChange(node)` (graph remaps) → `navigate({ node, question: live.question }, true)`.
  This keeps a failed focus through moves; `reconcileFocus` fixes the rest.
- `openPending(key)` → `openPendingTarget` (from `store.getState()`) → `navigate` (push).
- `askAside(text)` → `askAsideTarget(live)`. `'disabled'` → return; a patch → navigate; then
  seed as today. `ChatView.onAskAside = url.question ? null : askAside`.
- `onNodesChanged` additionally calls `store.applyLocal`: `delete` → `dropUnder(tree, ids)`,
  `move`/`rename` → `remap(tree, map)`.
- `onTreeRenamed(from, to)` → `store.applyLocal(renameTree)` **before** `followTreeRename`.
- Render `<QuestionEffects />`, the blockers provider + dialog (step 8) and `<Notices />` (step 9).
- `SideChatView` key stays `${tree}:${anchor}`. A new anchor remounts it, and the old draft goes
  to the stash.

### Step 7 — Pending nodes in the graph

`web/src/components/graph/layout.ts` (change)
- `PENDING_PREFIX = '__q__:'`, `pendingFlowId(key)`, `isPendingFlowId(id)`. `__q__:` cannot
  collide with Unicode names, because `_` and `:` are outside `\p{L}\p{M}\p{Nd}`.
- `layoutTree(title, nodes, ghostParent, pending: readonly PendingBox[] = [])`:
  - Per parent: real children first, then pending boxes (by `createdAt`), then the ghost.
  - Boxes whose parent is not in the tree are skipped. Edge id `edge:__q__:<key>`.
- `BoxData` adds:
  - `pendingKey: string | null`, `pendingStatus: PendingStatus | null` (decoration).
  - `focus: boolean` (main focus), `open: boolean` (foreground-aside focus).
  - `escArmed: boolean`, `tooltip: string`.
  - Remove `busy`.
- Pending boxes: `nodeId: ''`, `draggable: false`, `selectable: false`.
  `sizeOf(label, isRoot, maxLines)` uses `maxLines = 1` for pending boxes.

`web/src/components/graph/BoxNode.tsx` (change)
- Pending variant: `box box-pending box-pending-<status>` (+ `box-focus`, `box-open`).
  - `<svg className="box-ring" aria-hidden>` with a `<rect x=0.5 y=0.5 width={width-1}
    height={height-1} rx=2.4>`, using `width`/`height` from `NodeProps`.
  - A `!` glyph for `failed`.
  - An "Esc again to cancel" hint while `escArmed`.
- `.box-label` gets `dir="auto"`. `title` = `data.tooltip` for pending boxes.
- Delete the `box-busy` class logic.

`web/src/components/graph/GraphView.tsx` (change)
- Props: drop `busy`. Add `focus: { main: string | null; side: string | null }` and
  `onOpenPending(key)`.
- Store hooks: `busy = useTreeBusy(tree.id)`, `boxes = usePendingBoxes(tree.id)`, `statuses =
  usePendingStatuses(tree.id)`.
- `visibleBoxes = useMemo(() => boxes.filter(b => !(b.nodeId && known.has(b.nodeId))), [boxes,
  known])`. A done box stays until the refetched tree contains its node, so there is no empty
  frame.
- `ghostParent = focus.main || mainOutboxAt(currentId) ? null : currentId`.
- Layout memo deps: `[tree.title, tree.nodes, ghostParent, visibleBoxes, fontsVersion]`.
  **Relayout only on add/remove/remap/label, never on a chunk or a status change.**
- `decorate` handles pending boxes:
  - `pendingStatus` from `statuses`.
  - `focus` = box whose `questionId === focus.main`. `open` = the same for `focus.side`.
  - `escArmed`, `tooltip` (title + localized status/error).
- Edges:
  - Pending targets get `edge-pending` (or `edge-failed`).
  - The edge to the focused pending box is `edge-chain` + `animated`.
- `animateTo.startOf`:
  - A new real node whose id equals a box's `nodeId` starts at that box's previous position
    (map `nodeId → pendingFlowId` from `boxes`).
  - New pending boxes grow from the ghost spot (existing rule).
- Pan-to-current and the initial focus use the focused pending box when `focus.main` is set.
- `onNodeClick`: a pending box → `onOpenPending(key)` (modifiers ignored). Ghost unchanged.
- `findDropTarget` excludes pending boxes. `renameTargetOf(selection, focus.main ? '' :
  currentId)`.
- Keyboard: `onKeyDown` on `.graph`. The target is `event.target.closest('.react-flow__node')`
  with `data-id` starting with `__q__:`.
  - `Enter` → open the box.
  - `Escape` on a running box (`sending` | `uploading` | `streaming`): first press arms it for
    2 s, second press within 2 s → `store.abortOutbox`/`store.cancel`.
  - The window-level Esc (clear selection) stays.
- `frozen = busy || undo.pending` (busy now comes from the store).

`web/src/styles/graph.css` (change)
- `.box-pending`: transparent border, `--surface` background, `--muted` label,
  `-webkit-line-clamp: 1`.
- `.box-ring` (absolute, `pointer-events: none`). Its `rect`:
  - `fill: none; stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 4 3;
    vector-effect: non-scaling-stroke`.
  - `animation: box-march 0.6s linear infinite` (`stroke-dashoffset` → `-7`).
- Per status:
  - `naming`/`done`: 1.6 s march.
  - `sending`/`uploading`: `--accent-line` stroke.
  - `failed`: `--danger` solid stroke, `--danger-soft` background, `--danger` label, no
    animation.
  - `cancelling`: opacity 0.5.
- `.box-focus`: stroke-width 2 and `--text` label. `.box-open`: `--select` stroke.
- `.react-flow__edge.edge-pending path` (dashed `--accent-line`) and `.edge-failed path`
  (dashed `--danger-line`).
- Delete `.box-current.box-busy` and `@keyframes box-busy`.
- Add `.box-ring rect` to the `prefers-reduced-motion` block (static dashes, no march).

### Step 8 — Blockers dialog and 409 handling

`web/src/components/graph/blockers-context.ts` (create)
- `BlockersContext` with `showBlockers({ tree, error?: unknown, retry?: { label: string; run:
  () => void } })`. Default: no-op.

`web/src/components/graph/BlockersDialog.tsx` (create; uses `Dialog`)
- Live `blockerList(store state, tree, opened)` via `useStoreSelector`. `opened.details =
  treeBusyDetailsOf(error)` and `opened.snapshotCount` are taken at open.
- Each row:
  - `pendingLabel(title)` and "under `<IdPath parent>`" (+ "aside" tag).
  - Status (`Answering…` / `Saving… (finishes by itself)` / `Cancelling…`).
  - **Open** → `onOpenQuestion(id)` + close. **Cancel** for `streaming` only →
    `store.cancel(id)`.
- Text lines:
  - `blockers.preparing` when `details.preparing > 0`; `uploading` outbox count.
  - "Nothing is running now." when the list is empty.
- Footer:
  - **Cancel all** (streaming items, `Promise.allSettled`) and **Close**.
  - With `retry`: a primary **`retry.label`**, enabled when `items.length === 0 && uploading ===
    0`. It runs `retry.run()` and closes. A new 409 reopens the dialog with fresh details.

`web/src/App.tsx`: holds `blockers` state, provides `BlockersContext`, renders `<BlockersDialog>`
(open → `onOpenQuestion` = `openPending` by id).

`web/src/components/graph/GraphView.tsx`
- Toolbar while busy: `graph:busyCount` (running + uploading) + **Show…** →
  `showBlockers({ tree })`. This replaces `t('busy')`.
- `remove`/`move`/`rename` `onError`: if `treeBusyDetailsOf(error)`:
  - `setDialog(null)`, reset the mutation.
  - `showBlockers({ tree, error, retry: { label, run: () => mutation.mutate(vars) } })`.
  - Other errors stay inline as today.
- `onUndoApplied` unchanged (App's `onNodesChanged` does the store remap).

`web/src/lib/undo-history.ts` (change): `UndoOutcome.error` gains `cause: unknown` (the original
error). `classifyUndoError` is unchanged (409 keeps the entry).

`web/src/components/graph/useTreeUndo.ts` (change)
- Option `streaming` → `busy`. New `onBusy?: (error: unknown | null, retry: () => void) => void`.
- Ctrl+Z while `busy` → `onBusy(null, undo)` (instead of the busy toast).
- An outcome whose `treeBusyDetailsOf(cause)` is set → `onBusy(cause, undo)` instead of the
  toast. The entry is kept, as today.
- GraphView wires `onBusy` to `showBlockers({ tree, error, retry: { label: blockers.retry.undo,
  run } })`.

`web/src/components/sidebar/TreeSettings.tsx` (change)
- `save.onError`: a busy 409 → `save.reset()` + `showBlockers({ tree: tree.id, error, retry: {
  label: blockers.retry.renameTree, run: () => save.mutate(patch) } })`.
- `onSuccess` with a new id → `store.applyLocal(renameTree)` happens in App's `onTreeRenamed`
  (step 6). Nothing extra here.

### Step 9 — Notices, connection indicator, sidebar badges

- `web/src/components/ui/Notices.tsx` (create)
  - Fixed stack in the graph pane's bottom-right, `role="status" aria-live="polite"`.
  - Each notice: an `ErrorNote`-like row with dismiss, auto-dismissed after 8 s.
  - Rendered in `App`. CSS in `styles/base.css` (`.notices`).
- GraphView toolbar: `useConnectionStatus()`. When the status is `reconnecting` for more than
  3 s after having been live, show muted `graph:reconnecting`. Hidden while `paused`, because the
  tab is hidden anyway.
- `web/src/components/sidebar/TreeList.tsx` (change): `useTreeCounts()`. A tree with running
  answers shows a small accent badge with the count (`sidebar:trees.running`). A tree with failed
  answers shows a `--danger` dot (`sidebar:trees.failed`). This is the cheap discoverability for
  background questions in other trees. CSS `.tree-badge`, `.tree-failed`.

### Step 10 — Unicode display, i18n, CSS polish

- `web/src/components/ui/IdPath.tsx` (create):
  - Renders `''` as `common:root`.
  - Otherwise renders segments as `<bdi>` joined by `/`, inside `<code dir="ltr">`. RTL segments
    do not reorder the path.
- Use it in `DeleteDialog` (id list), Composer target, side title, blockers rows and notices.
- `dir="auto"` on `.crumb`, `.node-link` and `.box-label`. Grapheme truncation via
  `lib/text.ts` for labels, tooltips and notice titles. Never `slice`.
- `graph:renameDialog.hint` (en/ru): "Letters of any language, digits and dashes; lowercased;
  long names are shortened. If a sibling already has the name, "-2" is added. Ids of this node
  and its descendants change."
- i18n keys:
  - English is listed below. Russian mirrors every key; count keys need `_one/_few/_many/_other`.
    `Messages<typeof en>` enforces parity at `tsc`.
  - **chat**:
    - Remove `answeringUnder`, `show`, `notSaved`, `uploadingFiles`, `answering` and
      `composer.stop`.
    - Add `inFlight.{sending, uploading, answering, saving, cancelling, failed, notSent, loading,
      retry, retrying, dismiss, cancel}`.
    - Add `failure.{agent_error: 'The answer failed: {{message}}', timeout: 'The answer took
      longer than 30 minutes and was stopped.', internal: 'The answer could not be saved:
      {{message}}'}`.
    - Add `retryParentMissing`, `composer.{cancel, saving, waitingFor, failedFocus}` and
      `attachments.{attached, keptForRetry}`.
    - Reword `side.waitAnswer` ("Wait until the answer is saved").
  - **graph**:
    - Remove `busy`. Add `busyCount_one/_other` ('{{count}} answering · changes paused'),
      `showBlockers`, `reconnecting`.
    - Add `pending.{sending, uploading, streaming, naming, failed: 'Failed: {{message}}',
      cancelling, escAgain}`.
    - Add `blockers.{title, body_one/_other, preparing_one/_other, uploading_one/_other, none,
      under, aside, open, cancel, cancelAll, saving}` and `blockers.retry.{move, delete, rename,
      undo, renameTree}`.
  - **common**:
    - Add `errors.{busyStreamingCount_one/_other, parentMissing, questionNotFound,
      questionFinished}`.
    - Add `notices.{cancelledElsewhere, dismissedElsewhere, expired, parentDeleted, vanished,
      serverRestarted_one/_other, notSent}` (each takes `{{title}}`, `notSent` also takes
      `{{message}}`).
    - Remove `errors.emptyResponse` and `errors.streamEnded` (only `sendMessage` used them).
  - **sidebar**: add `trees.running_one/_other` and `trees.failed_one/_other`.

### Step 11 — Docs (the developer reviews them)

- `CLAUDE.md` → Architecture → Web:
  - Questions store (`lib/questions.ts` pure reducer/selectors, `lib/question-store.ts`,
    `lib/question-sync.ts`).
  - One app-wide SSE per tab (`api/question-events.ts`, fetch loop, watchdog, hidden-tab
    disconnect).
  - Panels = composer + focus (`useComposer`, `useInFlight`).
  - URL `q`/`sideQ` (+ NFC on read) and `reconcileFocus`.
  - Pending boxes in `layoutTree` (`__q__:` flow ids).
  - Blockers dialog on 409. Undo `busy` → blockers.
  - The rule "the graph never subscribes to stream text".
- `README.md`: coordinate with server step 9 (the server adds the feature bullets). The web adds
  the UI details: pending nodes with marching outline, click to reopen, Esc twice to cancel,
  Retry/Dismiss on failed nodes, "N answering · Show…" blockers dialog, sidebar badges.

### Step 12 — Verify

- `pnpm check`, `pnpm lint`, `pnpm --filter @otago/web test`.
- Manual with the server (`pnpm dev`, real SDK):
  - Two main questions under different nodes, plus one under the same parent.
  - Two asides (the background one reopens by clicking its box).
  - Reload mid-stream: catch-up with no duplicated text, `q` reopens the stream.
  - Cancel via Composer, Esc×2 and the blockers dialog.
  - Failed question: Retry and Dismiss (simulate with a bad model or by stopping the network).
  - Move/delete/undo/tree rename while busy → blockers dialog → Cancel all → retry action.
  - Server restart (`tsx watch` edit) → "Reconnecting…" → notice about lost questions.
  - A Cyrillic node name: NFD pasted `?node=` resolves.
  - Reduced motion: static dashes.
  - Hidden tab for over 30 s, then back → resync.

## Interface changes (summary)

| Where | Before | After |
|---|---|---|
| `api/client.ts` | `sendMessage` (POST-SSE `/messages`), `buildMessageBody` | `api.startQuestion` (202), `api.cancelQuestion`, `api.retryQuestion`, `buildQuestionBody` (+`context`); `ApiError.details`; question codes |
| `api/sse.ts` | `{ event, data }` | `{ event, data, id? }`; `readSse(body, { onBytes })` |
| URL | `?tree&node&side&sideNode` | `+ q` (main focus), `+ sideQ` (aside focus); NFC on read |
| `UrlState` | `{ tree, node, side: { anchor, head } }` | `{ tree, node, question, side: { anchor, head, question } }`; `advanceSide` removed |
| `GraphView` props | `busy` | `focus: { main, side }`, `onOpenPending`; busy from the store |
| `ChatView` props | `onStreamingChange`, `askAsideEnabled` | `question`, `onAskAside: fn \| null` |
| `SideChatView` props | `onAdvance`, `onStreamingChange` | removed (focus follows via `reconcileFocus`) |
| `Composer` props | `streaming`, `onStop` | `locked`, `onCancel?`, status text |
| `ChatThread` props | `pending`, `showPending`, `onDismissError`, `pendingFooter`, `errorText` | `inFlight`, `inFlightActions`, `inFlightFooter` |
| `useTreeUndo` | `streaming` → busy toast | `busy`, `onBusy(error, retry)` |
| `layoutTree` | `(title, nodes, ghostParent)` | `(title, nodes, ghostParent, pending)` |
| `canPromote` | `(side, streaming)` | `(side)` |

## Test plan (Vitest, node environment; no DOM, no real server)

- `lib/text.test.ts`:
  - Grapheme cut of ZWJ emoji and Devanagari marks.
  - No double ellipsis, unchanged when it fits.
  - `firstLine`, `collapseWhitespace`.
- `api/sse.test.ts`: `id:` parsed (and ignored with NUL); comments → no event but `onBytes` fires.
- `api/client.test.ts`:
  - Drop the `sendMessage` tests.
  - `buildQuestionBody`: JSON with `context`; multipart with `payload` first (incl. `context`)
    and one part per file.
  - `startQuestion` URL/method/body + `signal` passed + 202 body → `QuestionInfo`.
  - `cancelQuestion` (DELETE, 204 → undefined), `retryQuestion` (POST, no body).
  - `ApiError.details` kept for 409; question codes whitelisted; unknown codes ignored.
- `api/question-events.test.ts` (stubbed `fetch`, `sseResponse` helper, fake timers):
  - `parseQuestionEvent`: every event; unknown → null; malformed → throws.
  - Snapshot → `live` + backoff reset.
  - 502 `text/plain` → retry after the backoff. Wrong content type → retry.
  - End of stream → reconnect.
  - Watchdog: no bytes for 45 s → abort + reconnect. Pings keep it alive.
  - `resync()` → immediate reconnect without backoff. `stop()` → no further fetch.
  - A first event other than `snapshot` → reconnect.
  - `nextBackoff` stays within bounds.
- `lib/questions.test.ts`:
  - Snapshot replace/remove (`restart` vs `missing` by instance); done keeps the local stream;
    unconfirmed kept; done-first-seen acked.
  - 202 vs `question` in either order: no regression, attempt-based HTTP merge, tombstoned id
    ignored.
  - Chunks: append, overlap dedupe, exact duplicate returns the same state, gap → `resync` with
    unchanged state, stale attempt dropped, newer attempt resets.
  - Attachments per attempt. `removed` cleans every map and adds a tombstone (cap 500).
  - Outbox add/accepted (files → `localFiles`, `localKeys`)/failed/drop.
  - `cancel/*`. `ack` drops the stream and files.
  - `local/remap`, `dropUnder`, `renameTree`:
    - The prefix rule respects the `/` boundary (`a` does not touch `ab`).
    - The anchor fix-up works.
    - Running entries are untouched.
  - `expireUnconfirmed`. Lifecycle diffs (types, sources, `local` flag).
  - **Selector identity**: a chunk returns the same `pendingBoxes`, `pendingStatuses`,
    `treeQuestions` and `isTreeBusy`. A status change keeps `pendingBoxes` and changes
    `pendingStatuses`. `createCachedSelector` returns the previous reference for an equal value.
  - `pendingLabel` (40 graphemes, server-cut title), `inFlightStatus`, `inFlightCanCancel`.
  - Cyrillic parent ids throughout.
- `lib/question-store.test.ts` (stub `api`, manual `schedule`):
  - `ask`: outbox → 202 → `accepted` lifecycle.
  - Claim returning true keeps the failed entry. Unclaimed failure → `outbox-ended{ shown:
    false }` and the entry is dropped.
  - Abort → aborted.
  - `cancel` 204 / 404 / 409 `question_finished` / network error. `dismiss`. `retry` 202 merge
    and 404.
  - Published state changes only on flush. Lifecycle listeners are synchronous and run in order.
- `lib/question-focus.test.ts`:
  - `reconcileFocus`:
    - Unknown after/before hydration; other tree.
    - Done unacked (no change) vs acked (follow to `nodeId`, main and side).
    - Parent remap → `node`/`side` follow.
    - Side context mismatch.
    - Idempotence (patch applied → null).
    - Ported `advanceSide` stale-completion cases.
  - `acceptedFocus` (push only while the URL still targets the same parent with no focus).
  - `openPendingTarget` (main/side, head null when `parentId === anchor`, outbox).
  - `askAsideTarget` (disabled, reuse, new aside when `sideQ` set).
- `lib/blockers.test.ts`:
  - `treeBusyDetailsOf` (valid, malformed filtered, other codes → null).
  - `blockerList` merge: store + server-only. Server-only dropped by tombstone, non-running or a
    newer snapshot. `uploading` counts; `cancelling` flag.
- `lib/draft-stash.test.ts`: get/set/clear, empty deletes, `stashKeyOf`, `mergeDraft`.
- `lib/notices.test.ts`: dedupe by key, cap, remove.
- `lib/url-state.test.ts`:
  - `q`/`sideQ` round trips. `sideQ` ignored without `side`; `q` ignored without `tree`.
  - Write order.
  - Merge: tree switch resets `question`; node change resets `question` unless given;
    `question` kept on a same-node update.
  - `openSide`/`promoteSide`/`followTreeRename` with questions.
  - NFD `?node=`/`side`/`sideNode` read as NFC.
  - Cyrillic ids round-trip with unescaped `/`.
- `lib/side-chat.test.ts`: `canPromote` with `question`.
- `lib/tree.test.ts`, `lib/undo-history.test.ts`:
  - Cyrillic ids in `afterMove`/`afterDelete`/`remapId` (`основы` vs `основы-2`
    boundaries).
  - `runUndo` outcome carries `cause`.
- `lib/chat-errors.test.ts`: busy count text with details; `parent_not_found` → node-missing;
  question codes; `describeQuestionFailure` per code.
- `api/queries.test.ts`: `seedDoneChain` seeds from the cached parent chain and skips without it.
- `components/graph/layout.test.ts`:
  - Pending boxes after the real children, ordered by `createdAt`, before the ghost.
  - Flow/edge ids.
  - A missing parent is skipped.
  - One-line height.
  - Same `nodes` + same `pending` ⇒ the same positions (determinism).
- `components/chat/InFlightExchange.test.tsx` (`renderToStaticMarkup` smoke):
  - Answering with caret; saving without caret.
  - Failed with Retry/Dismiss and a localized failure; not-sent.
  - Staged files by name.
- `i18n` parity is enforced by `tsc` (`Messages<typeof en>`).

## Extension points (left open, not implemented)

- **Multi-tab sync.** The store is fed only by server events; the outbox and `cancelling` are
  ephemeral; focus is per tab (URL). Next step: one connection per browser.
  - A leader tab (`navigator.locks.request('otago-events')`) runs `createQuestionConnection`.
  - It fans the events out over `BroadcastChannel`.
  - Followers inject a channel-backed `connection` into `startQuestionSync`.
  - The tree caches of other tabs already refresh on `done`. Structural changes from another tab
    would need a server `tree_changed` event, which `parseQuestionEvent` already ignores safely.
- **Completion notifications.** `store.onLifecycle` for `done`/`failed` with `source: 'live'` is
  the hook, when `document.hidden` (`Notification` or a sound, deduped across tabs with the same
  Web Lock).
  - Needs `hiddenDisconnectMs: null` (or the leader tab) so that hidden tabs stay connected.
  - `Notices` and the sidebar badges are the in-app first step.
- **Pending file thumbnails.** `UserFileList` `staged` variant. A future
  `GET /api/questions/:id/files/:name` slots in.
- **Retry with another model.** `store.retry(id)` would gain a body (contract seam).

## Risks and notes for the implementer

- **Selector stability.** One unstable selector with `useSyncExternalStore` loops renders. Every
  hook must go through `createCachedSelector`, and the identity tests are mandatory.
- **Published vs current state.** React reads only the published snapshot (flushed per frame);
  lifecycle handlers read `getState()`. Mixing them up makes the URL logic read stale data.
- **Always read the live URL** in async handlers (`readUrlState(location.search)`): `done` and
  the 202 race with navigation.
- **Lockstep.** Step 6 needs the server's question routes. Do not ship the web without them,
  because `/messages` returns 404 afterwards.
- **Behavior change.** Closing the tab or switching panels no longer stops an answer, so the cost
  keeps running. The pending boxes, sidebar badges and the blockers dialog are how users find
  and cancel them.
- **Render cost.** Markdown re-parses the focused answer at most once per frame. Marching dashes
  are fine for tens of boxes.
- **Dev restarts** (`tsx watch`) drop every running question (accepted non-goal). The client
  shows "Reconnecting…" and then one aggregated notice.
