# Research: parallel-questions, project `web`

Stage 2 (research) output. Nothing here is a plan or production code. Type sketches only illustrate shapes for the planning stage. Read together with `projects/server/research.md` (the server owns the contract).

## 1. Context

### 1.1 Stack (verified in `web/package.json` and the installed modules)
- React 19.3, Vite 8.3, TypeScript 7, Biome. The app is only ever served by the Vite dev server, which proxies `/api` to `127.0.0.1:3001` (README, `vite.config.ts`). The browser side is therefore HTTP/1.1.
- TanStack Query 5.103.2. `main.tsx` sets `retry: false` and `refetchOnWindowFocus: false`.
- `@xyflow/react` 12.11.6, `@dagrejs/dagre` 3.1.1, i18next (en + ru).
- Vitest 5 runs in the **node** environment, with no jsdom and no Testing Library. Tests cover pure `lib/*`, `api/*` and `layout.ts`, plus `renderToStaticMarkup` smoke tests. New logic has to live in pure modules to be testable.
- `zustand` 4.5.7 and `use-sync-external-store` 1.7 are already in the lockfile as transitive dependencies of `@xyflow/react`. They are not direct dependencies.

### 1.2 Existing patterns this feature touches (verified)
| Area | Where | What exists today |
|---|---|---|
| Chat session | `components/chat/useChatSession.ts` | One hook per panel owns the draft, files, file errors, model choice, a single `Pending \| null` and an `AbortController`. `send()` streams `POST /messages` through `sendMessage`. On `done` it seeds `keys.chain(tree, nodeId)` with a synthetic `ChainNode`, awaits `invalidateQueries(keys.tree)`, then calls `onSent(nodeId)`. Unmounting aborts the fetch, and that aborts generation on the server. `canSend` is false while streaming. |
| Panels | `ChatView.tsx`, `SideChatView.tsx`, `App.tsx` | `ChatView` is keyed by tree id. `SideChatView` is keyed by `tree:anchor`, so a new anchor remounts it and kills its stream. `App` tracks `mainStreaming`/`sideStreaming` through `onStreamingChange`, and their OR is the graph's `busy`. "Ask aside" is hidden while the side chat streams, because re-anchoring would abort it. `ChatView` shows the pending exchange only when `pending.parentId === currentId`; otherwise it shows an "Answering under X… Show" notice. |
| Thread | `ChatThread.tsx`, `Exchange.tsx`, `UserFileList.tsx`, `Markdown.tsx` | `ChatThread` takes `pending: Pending` (question, answer, `StreamingAttachment[]`, local `ComposerFile[]`, phase, error). Pending user files render from local `File` objects, with thumbnails through `LocalThumb`. `Markdown` is memoized by text but re-parses the **whole** answer on every change. |
| Transport | `api/client.ts`, `api/sse.ts` | `sendMessage` is a POST-SSE with `chunk`/`attachment`/`done`/`error` events. `readSse` + `createSseParser` ignore `id:`, `retry:` and comments. `errorOf` keeps `error` and a whitelisted `code` and drops `details`. `ApiErrorCode` is a closed union backed by whitelists. |
| URL state | `lib/url-state.ts` | `?tree=&node=&side=&sideNode=` through `URLSearchParams`, with a cosmetic `%2F` -> `/` replacement. `useSyncExternalStore` listens to `popstate`. `mergeUrlState` resets `node`/`side` on a tree switch. `advanceSide`, `promoteSide`, `remapSideAfterMove/Delete` and `followTreeRename` are pure and tested. A comment marks the "list seam" for several side chats. |
| Graph | `components/graph/GraphView.tsx`, `layout.ts`, `BoxNode.tsx`, `styles/graph.css` | `layoutTree(title, nodes, ghostParent)` runs dagre, memoized on `tree.nodes`, `currentId` and fonts. A **ghost** box (`__ghost__:<parent>`, dashed, label `…`) marks where the next answer will appear. New nodes glide out of the ghost's spot (`animateTo`/`startOf`). Decorations (`current`, `inChain`, `selected`, `dropTarget`, `busy`) go through `decorate` without a relayout. `busy` freezes Delete/Move/Rename/drag (`frozen`), and the current box "breathes" (`box-busy`). Chain edges use React Flow's `animated` (marching `stroke-dashoffset`). A reduced-motion block turns off every box and edge animation. `onNodeClick` ignores ghosts, and shift/⌘-click selects. |
| Undo | `lib/undo-history.ts`, `components/graph/useTreeUndo.ts` | While `streaming`, undo is refused locally with the busy toast. A 409 keeps the entry. `remapId` rewrites ids by prefix on `/` boundaries. |
| Tree rename | `components/sidebar/TreeSettings.tsx` | `PATCH /trees/:id` with a title takes the exclusive lock, so it gets a 409 while anything streams. The error is shown through `describeError`. |
| Errors | `lib/chat-errors.ts` | `describeError` maps `tree_busy_*` and `node_not_found` to localized text. |
| Theme tokens | `styles/themes.css` | `--danger`, `--danger-soft`, `--danger-line`, `--accent-line` and `--drop-ring` exist in every theme. `--radius` is 2.4px. |

### 1.3 Facts verified locally
- **The Vite 8.3 proxy answers 502 `text/plain`** when the backend is unreachable (`node_modules/vite/dist/node/chunks/node.js`, `proxy.on('error')`). `pnpm dev` runs the server under `tsx watch`, so every server edit opens such a window. A native `EventSource` treats any non-200 or non-`text/event-stream` response as fatal: `readyState` becomes `CLOSED` and it never reconnects. It would need a manual reconnect wrapper anyway.
- **The HTTP/1.1 limit of 6 connections is per browser and host:port, shared by all tabs.** Today an idle tab holds no connection. With one permanent SSE per tab, 5 open tabs leave a single connection for all `/api` traffic, and 6 tabs stall it completely.
- React Flow 12.11.6 node wrappers are focusable by default (`tabIndex=0`, `data-id=<flow id>`). With `elementsSelectable={false}`, React Flow ignores Enter and Escape on nodes. "Esc on a pending node" is therefore ours to implement: a bubbling `keydown` plus `closest('.react-flow__node')`.
- TanStack Query 5.103 notifies observers in `setTimeout(0)` batches and runs structural sharing on every `setQueryData`. `experimental_streamedQuery` exists, but it models **one AsyncIterable per query**, not one multiplexed stream for many entities.
- `URLSearchParams` percent-encodes UTF-8 and does **not** normalize. An NFD `?node=` arrives as NFD (11 vs 10 code units for `основы/йод`), and `startsWith` prefix checks fail across the two forms.
- `String.prototype.slice` splits ZWJ emoji (`'👩‍👩‍👧x'.slice(0, 3)` gives `"👩‍"`). `Intl.Segmenter` counts graphemes correctly.
- `web/src` has **no ASCII-only node-id logic** (grep for slug, kebab, `[a-z0-9]`, `\w`). `ATTACHMENT_NAME_PATTERN` and the citations regex apply to attachment and source file names, which this feature does not change. `tree.ts`, `url-state.ts` and `undo-history.ts` only split and compare on `/`, and `/` never occurs inside a UTF-16 surrogate pair.
- The flow-id prefixes `__root__`, `__ghost__:` and a new `__q__:` cannot collide with Unicode node names, because `_` and `:` are outside `\p{L}\p{M}\p{Nd}`.
- Source Serif 4 ships Cyrillic subsets. Other scripts use fallback fonts, and canvas `measureText` uses the same fallback, so dagre box sizes stay right.

## 2. Approaches

### 2.1 Where the client keeps in-flight questions (focus 1)
**S1. TanStack Query cache.** Per-question keys hold the text, a per-tree key holds the meta, and SSE handlers call `setQueryData`. `useQuery({ select })` limits re-renders.
- `setQueryData` is already the optimistic-update tool here (chain seeding, `applyHierarchy`, `moveTreeCaches`).
- These "queries" have no `queryFn`. They need `enabled: false` or `skipToken`, `staleTime: Infinity` and `gcTime: Infinity`. With the default 5-minute `gcTime`, the text of a background question that nothing observes would be garbage-collected.
- Structural sharing and `setTimeout(0)` notifications run on every chunk.
- Snapshot reconciliation, offsets and attempts become read-modify-write updaters spread over several keys, with `removeQueries` for cleanup. A push-fed state machine ends up inside a fetch cache.

**S2. Hand-rolled external store + pure reducer + `useSyncExternalStore`.**
- `lib/questions.ts` holds a pure `reduce(state, event)` and memoized selectors, testable in node.
- A store of about 80 lines provides `getState`, `dispatch`, `subscribe`, render notifications coalesced per animation frame, and a separate lifecycle listener channel.
- Hooks: `useQuestion(id)`, `useTreeQuestions(tree)`, `useTreeBusy(tree)`.
- Same patterns as `url-state.ts` (`useSyncExternalStore`) and `undo-history.ts` (pure core, thin hook).
- A chunk only touches the text slice. Meta selectors keep returning the same references, so React bails out.
- No GC surprises, and fully testable without a DOM.
- Cost: we own the subscription code and the memoized selectors. A selector that returns a fresh array makes `useSyncExternalStore` loop.

**S3. Zustand.** `create()` + `useStore(selector)`/`useShallow`.
- Idiomatic and tiny, and 4.5.7 is already in the lockfile.
- It is a new direct dependency for about 80 lines of value. Pinning `^4.5` dedupes, but v5 is current and would add a second copy. Selectors need the same stability care. The reducer logic is identical to S2.

**Rejected:** an App-level context + `useReducer`. Every chunk would re-render the provider subtree unless the state were split into many contexts.

### 2.2 Event transport for `GET /api/questions/events` (focus 1)
**T1. `fetch` + the existing `readSse` in a reconnect loop.**
- Reuses the parser and the `sseResponse` test helper from `client.test.ts`.
- Full control: backoff with jitter, retry on any status (including the proxy's 502), a heartbeat watchdog, and aborting on demand (gap, hidden tab). Same style as today's `sendMessage`.
- About 40 lines of loop. `Last-Event-ID` would be manual, and v1 ignores it anyway.

**T2. Native `EventSource`.**
- Built-in reconnect after network drops. Honors `retry:`, sends `Last-Event-ID` automatically, and the browser does the parsing.
- Fatal on the dev proxy's 502 (1.3), so it needs a wrapper that recreates it.
- No watchdog: a half-open TCP connection after laptop sleep stays "open".
- Not available in the node test environment without a polyfill.

**Rejected:** per-question streams (server A1/A2). Each one spends a connection from the shared pool.

### 2.3 Chat session model (focus 2)
**C1. Keep a per-panel `useChatSession` with a list of pendings.** Questions must outlive panels (aside switch, reload, tree switch), and hook state dies on unmount. Rejected.

**C2. Questions live in the store; panels own only composer state and a *focus* (which question they show).**
- `useChatSession` splits into:
  - `useComposer`: draft, files, file errors, model choice, quote.
  - A focus read from the URL plus `useQuestion(id)`.
- Sends go through `store.ask()`. It keeps an **outbox** entry (local id, `AbortController`, local `File`s) until the 202 arrives.
- Background vs foreground is simply "which id a panel shows". The same code serves the main chat and the asides, and a reload is the same store fed by the snapshot.

**C3. A global registry of chats, including drafts.** Drafts would survive aside switches. But it puts `File` objects and drafts in global mutable state, which is more than the feature needs. A small per-anchor draft stash (4.5) gives the same benefit.

### 2.4 How the URL relates to the focus (focus 2)
**U1. New params: `q=<questionId>` (main focus) and `sideQ=<questionId>` (side focus)**, next to `node`/`side`/`sideNode`.
- Keeps the "navigation state lives in the URL" convention.
- A reload reopens the exact live stream, and Back/Forward work.
- The foreground aside is exactly the URL aside, which is the feature's rule.
- UUIDs are URL-safe.
- Needs a rule for "unknown until the first snapshot" and for stale ids (dropped with `replaceState`).

**U2. Keep the focus in memory only.** Simpler, but a reload lands on the parent, the user has to click the pending node again, and it breaks the convention.

**U3. Derive the focus from `node`/`side` and the store.** This is ambiguous: several pending questions can share one parent in the main chat, or one anchor/head in an aside. Rejected.

### 2.5 Pending nodes in the graph (focus 3)
**G1. Inject synthetic boxes in `layoutTree`, like the ghost.**
- `layoutTree(title, nodes, ghostParent, pending)` adds one box per question (`__q__:<id>`) after the real children of its parent.
- The memo input is a selector result that changes only on add, remove, parent remap or title change. Status changes go through `decorate`.
- Dagre places siblings without overlap, and the ghost's dashed style and glide animations are reused.

**G2. Hand-positioned overlay boxes outside dagre.** No relayout at all, but the boxes overlap real siblings and each other, and subtrees do not make room. Rejected.

**G3. Fake `HierarchyNode`s merged into the `['tree', id]` cache.** This pollutes server state: selection, `known`, the move dialog, undo and `findNode` would all see fake ids, and a refetch wipes them. Rejected.

### 2.6 Animated dashed outline (focus 3)
**B1. SVG `<rect>` overlay inside the box.** It uses `stroke-dasharray` with an animated `stroke-dashoffset`, `rx` equal to the radius, and `vector-effect: non-scaling-stroke`.
- Real dashes that follow the rounded corner.
- The same technique React Flow uses for `animated` edges, which this app already shows on chain edges.
- Paint-only cost. It matters only with hundreds of animated elements (the Liam ERD measurements); pending boxes are a handful.

**B2. Four `linear-gradient` dash strips animated through `background-position`.** No SVG, but it ignores `border-radius`, needs more CSS, and costs the same paint.

**B3. `@property --angle` + a `conic-gradient` ring with `mask-composite`.** A smooth "spinner" border (Baseline 2024, Firefox 128+), but it is not dashed, looks uneven on rectangles, and needs more CSS than B1.

**B4. Static dashed border + an opacity/box-shadow pulse**, like `box-busy`. Compositor-friendly, but it is not the requested marching outline. It is the right reduced-motion fallback, without the pulse.

### 2.7 Cancel affordances (focus 5)
- **Chat:** the Composer's Stop button becomes Cancel (`DELETE`).
- **Graph, Esc on a focused pending node.** GraphView already uses Esc to clear the selection, and clicking a node focuses it, so a plain Esc would cancel by accident. Options:
  - (a) Cancel immediately.
  - (b) Two-step: the first Esc shows "Esc again to cancel" on the box for about 2 s.
  - (c) A confirm dialog.
- **409 / busy UX:** a blockers dialog that lists running questions, with Cancel per item and Cancel all.

## 3. Trade-offs

| Topic | Option | Correctness | Complexity | Fit with codebase | Multi-tab / notifications later |
|---|---|---|---|---|---|
| Store | S1 Query cache | `gcTime`/no-`queryFn` pitfalls, per-chunk structural sharing | Medium | Partial (a cache for fetched state) | OK |
| | **S2 external store + pure reducer** | **Exact control of snapshot, offsets, attempts** | **Low-medium** | **`url-state` + `undo-history` patterns** | **Lifecycle channel is the hook point** |
| | S3 Zustand | Same as S2 | Low, plus a dependency | New direct dependency | Same as S2 |
| Transport | **T1 fetch loop** | **Survives the proxy's 502, watchdog** | **Low** | **Reuses `readSse` and its test helper** | **A leader tab can run the same loop** |
| | T2 EventSource | Needs a wrapper for the 502 | Low-medium | New API, not testable in node | Same |
| Session | C1 per-panel pendings | Questions die with panels | Low | Close to today | Weak |
| | **C2 store + panel focus** | **Questions outlive panels** | **Medium** | **Splits `useChatSession`** | **Tab-agnostic** |
| URL | **U1 `q` / `sideQ`** | **Exact reopen after reload** | **Low-medium** | **Navigation in the URL** | **Focus is per tab** |
| | U2 memory only | Loses the focus on reload | Low | Breaks the convention | - |
| Graph | **G1 layout injection** | **No overlap; relayout only on add/remove** | **Low-medium** | **Reuses the ghost logic** | - |
| Outline | **B1 SVG dashoffset** (B4 for reduced motion) | **Rounded, real dashes** | **Low** | **Same as animated edges** | - |
| Esc | **Two-step** | **No accidental cancel** | **Low** | **Extends GraphView key handling** | - |

## 4. Recommended approach

### 4.1 Module layout
- `api/types.ts`: `QuestionInfo`, `QuestionStatus`, `QuestionContext`, the event payloads (`snapshot`, `question`, `chunk`, `attachment`, `removed`) and the new error codes, hand-mirrored from the server contract as today.
- `api/client.ts`: `api.startQuestion(tree, input, signal)` (reuses `buildMessageBody` and adds `context`), `api.cancelQuestion`, `api.retryQuestion`, `api.getQuestion`. `ApiError` gains `details`. `sendMessage` is removed.
- `api/question-events.ts`: the connection loop (T1).
- `lib/questions.ts`: pure state, reducer, selectors, `pendingTitle`, lifecycle diff.
- `lib/question-store.ts`: the store, `useSyncExternalStore` hooks and a context provider.
- `lib/url-state.ts`: `q`, `sideQ`, NFC.
- `components/chat/useComposer.ts` (what remains of `useChatSession`). The `Pending` type is replaced by a `QuestionView`.
- `components/graph/layout.ts` (pending boxes), `BoxNode.tsx` (pending variant), `styles/graph.css`, and a new `BlockersDialog` (next to `NodeDialogs.tsx`).
- i18n strings in en + ru.

### 4.2 Store and reducer (S2)
```ts
interface QuestionsState {
  questions: Record<string, QuestionInfo>;  // meta only (no `answer`), every tree
  streams: Record<string, QuestionStream>;  // text + live attachments per question
  localFiles: Record<string, ComposerFile[]>; // File objects of questions sent from this tab
  outbox: Record<string, OutboxEntry>;      // local sends until the 202
  cancelling: Record<string, true>;
  connection: 'connecting' | 'live' | 'reconnecting';
  hydrated: boolean;                        // first snapshot applied
}
interface QuestionStream { attempt: number; text: string; attachments: StreamingAttachment[] }
```
- **`snapshot`** is authoritative.
  - Replace `questions` with it. For each entry with `answer`, set `streams[id] = { attempt, text: answer, attachments }`.
  - For `done` entries without text, keep the local stream (it is needed for seeding).
  - Drop entries missing from the snapshot. When one of them was running locally, emit a `vanished` lifecycle event.
  - Set `hydrated`.
- **`question`** (upsert with the full meta) replaces the entry by id. When `attempt` grew, reset the stream to `''` and `[]`.
- **`chunk`**:
  - Drop it if the id is unknown or `attempt < stream.attempt`.
  - Reset the stream if `attempt > stream.attempt`.
  - If `offset > text.length`, it is a **gap**: leave the state unchanged and signal a resync.
  - Otherwise append `chunk.text.slice(text.length - offset)`. When that tail is empty (a duplicate), return the same state object.
- **`attachment`**: drop it on an attempt mismatch; otherwise apply the existing `applyAttachmentEvent`.
- **`removed`**: delete the id from `questions`, `streams`, `localFiles` and `cancelling`.
- **Local actions**:
  - `outbox/add`, `outbox/accepted` (moves the `File`s to `localFiles[id]`, deletes the outbox entry, upserts the question; the SSE `question` event may arrive before or after) and `outbox/failed`.
  - `cancel/start`, `cancel/end` and `connection`.
- **Selectors** are memoized and return stable identities:
  - `treeQuestions(tree)`: meta sorted by `createdAt`. It returns the previous array when the entries are element-wise equal, and chunks never change it.
  - `pendingBoxes(tree)`: `{ id, parentId, title }[]`. It changes only on add, remove or remap, and feeds the layout memo.
  - `isTreeBusy(tree)`: running (`streaming`/`naming`) plus outbox entries of the tree, because an upload already holds the shared lock. It is a boolean.
  - `questionView(id)`: info + stream + local files, for one panel.
  - `blockers(tree)`: the running questions, for the dialog.
- **Notifications.**
  - Every event is applied to the state immediately.
  - Render subscribers are notified once per animation frame: `requestAnimationFrame`, or `setTimeout(…, 50)` when `document.hidden`. This caps Markdown re-parses at the frame rate, the same idea as the AI SDK's `experimental_throttle`.
  - Only the focused main/side panels subscribe to text. The graph subscribes to meta only.
- **Lifecycle channel.** `store.onLifecycle(listener)` emits `{ type: 'added' | 'done' | 'failed' | 'retried' | 'removed' | 'vanished', question, source: 'live' | 'resync' }`. A pure diff of status before and after each event produces these, and it is unit-tested.

### 4.3 Connection (T1)
- **Setup.** Create the store and the connection once in `main.tsx`, next to the `QueryClient`. Running outside React means StrictMode's double effects cannot open two streams. Expose the store through a provider.
- **Loop.**
  1. `fetch('/api/questions/events')`.
  2. On a 200 with `text/event-stream`, read it with `readSse` and dispatch each event.
  3. On any error or end of stream, set `connection: 'reconnecting'`, wait with exponential backoff plus jitter (0.5 s up to a 10 s cap, reset after each snapshot), and retry. A 502 from the proxy is just another retry.
- **Watchdog.** Reset it on every chunk of bytes read, pings included. After 45 s of silence (3 server pings), abort and reconnect; this catches half-open TCP after laptop sleep. `readSse` needs a small `onBytes` hook for this.
- **Gap.** When the reducer signals a gap, abort and reconnect to get a fresh snapshot. That is the single recovery path; the UI does not need `GET …/questions/:id` in v1.
- **Visibility.** Disconnect after about 30 s hidden, and reconnect immediately on `visibilitychange` -> visible and on `online`.
  - Why: the 6-connection pool is shared across tabs (1.3).
  - It is lossless because the reconnect snapshot carries the full state. Only lifecycle events in hidden tabs are delayed, and notifications are a non-goal for now.

### 4.4 Side effects of lifecycle events
One App-level hook subscribes to the lifecycle channel. It always reads the live URL (`readUrlState(window.location.search)`), as `advance` does today.
- **`done`:**
  - Run `invalidateQueries(keys.tree(q.tree))`.
  - If the question is this tab's focus (`q` or `sideQ`):
    1. Seed `keys.chain(tree, nodeId)` from the cached parent chain, the local stream text and the done `attachments`/`files`, as today.
    2. Await the invalidation.
    3. Replace the URL: `{ node: nodeId, q: null }` for the main chat, or for the aside an extended `advanceSide` that also checks the question id.
  - Unfocused questions are not seeded; they are fetched on demand.
- **`removed` / `vanished` of a focused question:** drop `q`/`sideQ` (replace) and show a short notice: cancelled elsewhere, expired, parent deleted, or the server restarted.
- **`question` with a changed `parentId` on a focused question:** replace `node` or `side.head` with the new parent.
- The same channel is the notifications hook point (4.11).

### 4.5 Chat panels (C2)
- **Composer state (`useComposer`).**
  - Main chat: one draft, as today; it survives node and focus changes.
  - Asides: stash `{ draft, files }` per `tree:anchor` in an in-memory map on unmount and restore it on remount. Clear it on send and on an explicit close. `File` objects never leave memory.
- **Send flow.**
  1. `store.ask({ tree, parentId, context, text, files, model, namingModel })` creates an outbox entry (`uploading` with files, `sending` otherwise). The panel shows it at once and the composer is cleared.
  2. On the 202: if the live URL still targets the same parent with no focus (`node === parentId && !q`, or the same `side` anchor/head and `!sideQ`), push `q`/`sideQ`. Otherwise the question just appears in the graph.
  3. On an upload or validation error:
     - Panel still mounted: restore the draft and files and show the error inline, as today.
     - Panel unmounted: show a toast.
  - The outbox lives in the store, so switching asides during an upload does not abort it. Stop during the upload aborts the POST, and the server discards it.
- **Thread.** `ChatThread` takes a `QuestionView` (an outbox entry, or a server question + stream).
  - Status lines: "Uploading files…", "Answering…", "Saving…" for `naming` (the answer is complete and the caret is hidden), and "Failed" with the error plus **Retry** and **Dismiss**.
  - User files: the local `File`s when this tab sent the question, otherwise names only (see 5.2).
- **Composer while the focus is a pending or failed question.**
  - Send is disabled, because a pending node has no id yet.
  - Stop = Cancel while `streaming`. It is hidden during `naming`, because the answer is complete and cancelling would throw it away.
  - Keep the textarea disabled as today, which is simplest. Type-ahead is an option for planning.
  - "Ask aside" from a selection inside a pending exchange is disabled, because there is no anchor yet.
- **"Ask aside" is always enabled.** It reuses the open aside if that aside has the same anchor and no `sideQ`; otherwise it opens a new one. The old aside's question keeps streaming in the background.
- **Removed:** `onStreamingChange`, `mainStreaming`, `sideStreaming`, `askAsideEnabled` and the "Answering under X… Show" notice. The graph shows every pending question.
- "Open in main chat" (promote) stays disabled while the aside's focus is pending.

### 4.6 URL state (U1)
- `UrlState` gains `question: string | null` (main) and `side.question: string | null`, written as `q` and `sideQ`.
- `mergeUrlState`:
  - A tree switch also resets `question`.
  - A `node` change resets `question` unless one is given.
  - `openSide`/`closeSide`/`promoteSide` produce `side.question = null` and preserve or clear it consistently.
  - `remapSideAfterMove/Delete` keep it. Question ids never change; the server remaps their `parentId`.
- **Clicking a pending node:**
  - Main context: `navigate({ node: parentId, question: id })` (push).
  - Side context: `navigate({ side: { anchor, head: parentId === anchor ? null : parentId, question: id } })` (push).
  - Whatever that panel showed before goes to the background on its own.
- **Before `hydrated`**, an unknown `q` shows the parent chain plus a loading placeholder. After the first snapshot, unknown ids are dropped with `replaceState`, and known `done` ids follow to `nodeId`.
- `readUrlState` normalizes `node`, `side` and `sideNode` to **NFC**. Otherwise a pasted NFD link misses `node.id === currentId` and the chain keys. Writing keeps `URLSearchParams` (percent-encoded UTF-8, `%2F` -> `/`).

### 4.7 Graph
- **Layout.**
  - `layoutTree(title, nodes, ghostParent, pending: PendingBox[])`, where `PendingBox = { id, parentId, title }`.
  - Flow id `__q__:<id>`, edge id `edge:__q__:<id>`.
  - Boxes go after the real children of their parent, ordered by `createdAt` and before the ghost. Boxes whose parent is not in the tree are skipped.
  - `data.question = id` (`null` on real nodes), `draggable: false`, `selectable: false`.
  - Label: `pendingTitle(info)`, which takes the first line, collapses whitespace and keeps at most about 40 graphemes (`Intl.Segmenter`) + `…`. A file-only message uses its file names. The box is one line (`-webkit-line-clamp: 1`, and `sizeOf` limited to one line).
- **Memo.** `useMemo(() => layoutTree(…), [tree.title, tree.nodes, ghostParent, pendingBoxes, fontsVersion])`, where `pendingBoxes` is the memoized selector output. The graph re-lays out only on add, remove or remap, never on a chunk. Status (`streaming`/`naming`/`failed`), `cancelling` and `current` go through `decorate`.
- **Transitions.**
  - A `done` question keeps its box until the refetched tree contains its `nodeId`, so there is no empty frame. If the refetch fails, drop the box when it settles.
  - `animateTo.startOf`: a new real node whose id is a done question's `nodeId` starts at that box's position.
  - A new pending box already starts at its parent's ghost spot, through the existing logic.
- **Ghost.** `ghostParent = q ? null : node`. When the focus is a pending box, that box is "current", and pan-to-current targets it.
- **Visuals.**
  - BoxNode renders a pending variant: `<svg class="box-ring"><rect …/></svg>` with `stroke-dasharray: 4 3` and `animation: box-march 0.6s linear infinite`, stroked in `--accent`, with the label in `--muted`.
  - `naming`: a slower march.
  - `failed`: a static `--danger` ring, a `--danger-soft` background and a `!` glyph.
  - `cancelling`: dimmed.
  - Edges: `edge-pending` (dashed `--accent-line`) and `edge-failed`.
  - `title`/`ariaLabel`: the question (about 200 chars) plus the status or error.
  - Reduced motion: no march (static dashes). Add `.box-ring` to the existing `@media (prefers-reduced-motion: reduce)` block.
- **Interaction.**
  - `onNodeClick` on a pending box calls `onOpenQuestion(id)`; App picks the main chat or the aside from `context`. Modifier keys are ignored.
  - Pending boxes are excluded from `findDropTarget`, the selection and the rename target (`renameTargetOf` gets no current id while the focus is a question).
  - Esc: a `keydown` on the graph container. If `event.target.closest('.react-flow__node')?.dataset.id` is a running pending box, use the two-step cancel (2.7 b). The existing window-level Esc (clear selection) stays.
- **Frozen.** `busy = useTreeBusy(tree.id)` replaces `mainStreaming || sideStreaming` in `GraphView` and `useTreeUndo`. The `box-busy` breathing moves from the parent to the pending boxes.
- **Blockers UI.**
  - While busy, the toolbar shows "N answering · changes paused" with a "Show…" button. It opens a `BlockersDialog` listing the running questions of the tree: title, parent name, status, Cancel per item and Cancel all.
  - The same dialog opens on any 409 `tree_busy_streaming`: move, delete, rename, drag, Ctrl+Z, and the tree title rename in `TreeSettings`. It merges `ApiError.details.questions` with the store, and the server list wins when the store is stale.
  - The action buttons stay disabled while busy, as today, but the reason is now discoverable. Ctrl+Z while busy opens the dialog instead of the plain toast.
  - Cancel awaits the `DELETE`, which the server answers after teardown, so the structural action can be retried right away.

### 4.8 Cancel, Retry, Dismiss, errors, re-attach
- **Cancel:**
  1. `cancel/start` dims the box and disables its buttons.
  2. `DELETE /trees/:tree/questions/:id`.
  3. Outcomes:
     - 2xx: remove the entry locally (idempotent with the SSE `removed`).
     - 404 `question_not_found`: remove it locally.
     - 409 `question_finished` (`details.nodeId`): treat it as done (invalidate the tree; follow if focused).
- **Retry:** `POST …/retry` returns 202 with the same id and `attempt + 1`. The reducer resets the stream, and the box turns from red to dashed in place (decoration only).
  - 404 `parent_not_found`: stays failed and shows the message.
  - 409 `tree_busy_structural`: shows the message.
- **Dismiss:** `DELETE` on a failed entry.
- **Error plumbing:**
  - `ApiError` gains `details?: unknown`, with typed readers for `questions` and `nodeId`.
  - The code whitelists gain `question_not_found`, `question_finished` and `question_not_failed`.
  - `describeError` maps them, and the busy text names the count.
  - `ErrorBody.details` is no longer "400 only".
- **Re-attach after a reload needs nothing special.** The first snapshot hydrates the store, the graph renders the boxes, `q`/`sideQ` resolve, and the text continues from the snapshot's offset.

### 4.9 Unicode node ids
- NFC normalization in `readUrlState` (4.6). Everything else is already Unicode-safe (1.3):
  - `nameOf`, `parentIdOf`, `chainIds`, `isSameOrDescendant`, `afterMove`, `afterDelete`, `remapId` and `isValidHead` all work on `/` boundaries.
  - Ids arrive from the server in NFC.
- Display: the folder name is the label.
  - Add `dir="auto"` to `.box-label`, the crumbs and `.node-link`.
  - Isolate ids shown in `<code>` (delete dialog list, notices) with `unicode-bidi: plaintext` or `<bdi>` per segment, so RTL segments do not reorder the path.
- Rename dialog: update the hint (en/ru) to say letters of any script, digits and dashes; lowercased; long names shortened. `canSubmitRename` stays: the server sanitizes, and an input that sanitizes to the same name is a no-op rename.
- Every truncation in the UI uses graphemes (`Intl.Segmenter`), never `slice`.

### 4.10 Tests (node environment)
- **`lib/questions.test.ts`:**
  - Snapshot replace/remove and order independence (the 202 vs the `question` event).
  - Chunk dedupe (overlaps, duplicates) and gap detection.
  - Attempts: a stale chunk is dropped, a newer attempt resets.
  - Attachments per attempt, `removed`, the outbox lifecycle, lifecycle diffs.
  - **Selector identity**: a chunk must return the same `treeQuestions` and `pendingBoxes` arrays.
  - `isTreeBusy`, and `pendingTitle` (graphemes, file-only).
- **`api/question-events.test.ts`:** the loop with a stubbed `fetch` (reusing `sseResponse`), 502 -> retry, the watchdog under fake timers, abort.
- **`api/client.test.ts`:** `startQuestion` JSON/multipart (port the `buildMessageBody` tests), `ApiError.details`, the new codes. Drop the `sendMessage` tests.
- **`lib/url-state.test.ts`:** `q`/`sideQ` round-trips, the reset rules, NFC normalization and Cyrillic ids. Add Cyrillic ids to `tree.test.ts` and `undo-history.test.ts` (`remapId`).
- **`components/graph/layout.test.ts`:** pending box placement and order, edge ids, a missing parent is skipped, the ghost is suppressed while a question is focused.

### 4.11 Future hooks
- **Multi-tab.**
  - The store is fed only by server events. The outbox and `cancelling` are ephemeral and get reconciled, and the focus is per tab (URL).
  - Next step: one connection per browser. A leader tab (`navigator.locks.request('otago-events', …)`) runs the 4.3 loop and fans the events out over `BroadcastChannel`.
  - Tree caches in other tabs already refresh on `done`. Structural changes made in another tab would need a server `tree_changed` event on the same stream.
- **Notifications.**
  - Subscribe to `store.onLifecycle` for `done`/`failed` with `source: 'live'`, and show a `Notification` or a sound when `document.hidden`.
  - Dedupe across tabs with the same Web Lock.
  - A cheap first step is a sidebar badge per tree with running questions. Questions in other trees are otherwise invisible.

## 5. Notes on the server proposal
A3 (one app-wide stream with a snapshot plus offsets) suits the client well. It means one reducer, no attach step, and reload for free. Points to settle in the contract:
1. **Live attachments in the snapshot (needed).** `QuestionInfo` carries `attachments` only when done. After a mid-stream reload or reconnect, the client loses the `saving`/`ready`/`failed` states: inline `attachments/<name>` references stay "saving" and the attachment list stays empty until done. Add the reduced live list, or the ordered `AttachmentEvent[]` of the current attempt, to snapshot and detail entries.
2. **Staged user-file metadata (nice to have).** `fileNames` is enough for the title, but the thread shows file cards. Provide `files: { name, size, contentType, kind }[]` for running and failed entries; a fetch URL for thumbnails can come later. Without it, a reload or another tab shows names only.
3. **`error.code` on failed entries (nice to have).** `error: { message, code? }` (e.g. `agent_error`, `timeout`, `shutdown`) lets the UI localize and decide whether Retry makes sense.
4. **409 `details.questions` on every exclusive route.** That includes `PATCH /trees/:tree` (title rename) and `nodes/restore` (undo), not only move/delete/rename. Ids plus `parentId` are enough; the client derives titles from its store, with a server `title` as fallback.
5. **A server instance id in `snapshot` (nice to have).** For example `{ instance: <boot uuid>, questions }`. It lets the client tell "the server restarted and N questions were lost" from "they finished while disconnected". With `tsx watch` this happens often in dev.
6. **Per-question routes without the tree segment (minor, not blocking).** Ids are global UUIDs and the stream is app-wide. `/api/questions/:id` for detail, cancel and retry would avoid a stale tree id in the path right after a tree rename. If the routes stay tree-scoped, the client uses `question.tree` from the store, which `renameTree` updates keep fresh.
7. **Confirm in the contract:**
   - `question` events carry the full meta, not patches.
   - A new attempt's `question` event precedes its chunks on the stream.
   - `done` keeps `parentId`, `context`, `nodeId`, `attachments` and `files`.
   - Dropping the text at commit is fine, because the client has it.
   - Cancel during `naming` is allowed server-side; the client simply hides the button.
8. **No objection to:**
   - replacing `POST /messages` in lockstep;
   - the 202 + upsert-by-id ordering (no `clientRequestId` is needed);
   - `retry: 2000` and the ping comments. The fetch loop ignores `retry:`, and the watchdog uses the pings.

## 6. Risks
- **The connection pool is shared across tabs.** A permanent SSE per tab is new load on the 6-connection pool. Hidden-tab disconnect mitigates it; a leader tab is the real fix (4.11). The alternative of pointing the SSE straight at `:3001` (a separate pool) needs CORS and exposing the API URL to the client.
- **Render cost.**
  - Markdown re-parses the whole answer on every update. Mitigations: rAF coalescing, and only the focused panels subscribe to text.
  - Marching dashes are fine at tens of boxes, not hundreds (B4 is the fallback).
- **Selector stability.** One unstable selector with `useSyncExternalStore` causes render loops. Cover the memoized selectors with identity tests.
- **Focus races.** `done`/`removed` can arrive while the user navigates. Always read the live URL, as `advance` does today.
- **Hydration window.** Before the first snapshot, `busy` is unknown. Structural actions stay enabled, and the server's 409 plus the blockers dialog cover them.
- **Accidental cancel by Esc.** Mitigated by the two-step Esc. Cancel is also hidden during `naming`.
- **Outbox failure after the panel unmounted.** The draft cannot be restored there, so it surfaces as a toast.
- **Behavior change.** Closing the tab or switching panels no longer stops an answer, so answers keep costing money in the background. The blockers dialog and the pending nodes are the way to find and cancel them.
- **Dev server restarts lose every in-flight question** (accepted non-goal). Without 5.5, the client can only say "no longer running".
- **Bidi.** Mixed RTL/LTR ids can display confusingly; isolate them (4.9).

## 7. References
- React `useSyncExternalStore` (cached snapshots, selectors): https://react.dev/reference/react/useSyncExternalStore
- TkDodo, "Using WebSockets with React Query" (event-driven invalidation vs pushing data): https://tkdodo.eu/using-web-sockets-with-react-query
- TanStack Query `experimental_streamedQuery` (one AsyncIterable per query): https://tanstack.com/query/v5/docs/framework/react/reference/functions/experimental_streamedQuery
- AI SDK `useChat` `experimental_throttle` (throttling UI updates during streaming): https://ai-sdk.dev/docs/ai-sdk-ui/chatbot ; Resume streams (aborts are disconnects, not cancels): https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
- WHATWG HTML, Server-sent events ("fail the connection" on non-200 / wrong MIME, `retry`, Last-Event-ID): https://html.spec.whatwg.org/dev/server-sent-events.html ; summary of the non-200 behavior: https://git.jeena.net/jeena/en.javascript.info/raw/branch/master/5-network/12-server-sent-events/article.md
- "The Pitfalls of EventSource over HTTP/1.1" (6 connections per browser+host, shared across tabs): https://textslashplain.com/2019/12/04/the-pitfalls-of-eventsource-over-http-1-1/ ; MDN EventSource: https://developer.mozilla.org/en-US/docs/Web/API/EventSource
- React Flow performance (memoized custom nodes, avoid depending on the nodes array, simplify animations): https://reactflow.dev/learn/advanced-use/performance
- Liam ERD, cost of `stroke-dasharray` edge animations at scale: https://liambx.com/blog/tuning-edge-animations-reactflow-optimal-performance ; React Flow animated SVG edge: https://reactflow.dev/ui/components/animated-svg-edge
- Marching ants with SVG `stroke-dashoffset`: https://svgator.com/tutorials/marching-ants-stroke-path-animation
- `@property` Baseline 2024 (animated conic-gradient borders): https://web.dev/blog/at-property-baseline ; MDN `@property`: https://developer.mozilla.org/docs/Web/CSS/Reference/At-rules/@property
- MDN `Intl.Segmenter` (grapheme-safe truncation): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
- Web Locks API and BroadcastChannel (future leader tab): https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API ; https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- Local sources: `web/node_modules/vite/dist/node/chunks/node.js` (proxy 502), `web/node_modules/@xyflow/react/dist/esm/index.mjs` (`NodeWrapper` focus/keydown), `node_modules/.pnpm/@tanstack+query-core*/src/notifyManager.ts` (`setTimeout(0)` batching).
