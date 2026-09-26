# Web plan: side-chat

Project: `web` (React 19, Vite, React Flow, TanStack Query, TypeScript). Role: client.
Contract (read-only): `.claude/features/side-chat/contracts/` (`messages.ts`, `concurrency.ts`, `errors.ts`).
Server plan: `projects/server/plan.md`. The server adds a shared/exclusive lock and an optional `code` on 409 bodies. Nothing else changes on the wire.

## Scope

1. A new **Ask aside** selection action, offered in the main chat only.
2. A side-chat panel in a 4th grid column: `sidebar | graph | main chat | side chat`.
3. A reusable chat core, so the main and side chats share one send/stream/pending implementation and nothing is forked.
4. Side-chat state lives in the URL, so it survives reload and back/forward, and its shape can later become a list.
5. The graph is `busy` when either chat is streaming.
6. Error handling for 409 `code` values and for a missing anchor (404).

No new endpoints. No generated API types exist in this repo (`contracts/index.ts` says so). The web client mirrors the shapes by hand in `web/src/api/`.

## Current state (verified)

- `web/src/App.tsx`: a single `streaming` state (L28) feeds `GraphView busy` (L89). `ChatView` is rendered inside `section.chat-pane` (L98-122), keyed by `tree.data.id`. `selectTree` navigates `{ tree, node: '' }`. Source and attachment viewers render inside `.chat-pane`.
- `web/src/lib/url-state.ts`: `UrlState { tree, node }`, `readUrlState`/`writeUrlState`, `useUrlState` (pushState/replaceState plus a synthetic `popstate`). `navigate` resets `node` when the tree changes.
- `web/src/components/chat/ChatView.tsx`: all chat logic is inline. That covers the draft, `Pending`, model choice (localStorage `otago.models`), the abort ref, stick-to-bottom scrolling, and `send()` (L94-164). `send()` calls `sendMessage`, seeds `keys.chain(tree, nodeId)` from the parent chain, invalidates `keys.tree`, then calls `onSelectNode(nodeId)`. It also has the quote action (L167-175), `SelectionActions` (L275), the thread render (L204-273) and `Composer`.
- `web/src/api/client.ts`: `ApiError(status, message)`. `errorOf` reads only `body.error`. `sendMessage` (L126) throws `ApiError` for pre-stream HTTP errors and for SSE `error` events (status 500).
- `web/src/components/graph/GraphView.tsx`: `busy` disables delete, move and drag, and shows "Answering… changes are paused". Delete and move call `onCurrentChange(afterDelete|afterMove(currentId, …))`. Errors show in `ErrorNote`.
- `web/src/lib/tree.ts`: `afterMove`, `afterDelete`, `isSameOrDescendant`, `parentIdOf`, `nameOf`.
- `web/src/lib/layout.ts`: `clampChatWidth(width, viewport, sidebar)`, `defaultChatWidth`, `usePaneLayout` (chat width persisted in `otago.chat-width`).
- `web/src/styles/base.css` L49-56: grid `var(--sidebar-w) minmax(0,1fr) var(--chat-w)`. `.chat-pane` (L133-147) centres its reading column on the screen middle via `--chat-pad-l/r`, using `50vw`. In the mobile media query (L181-205), rows are `auto 50vh auto`.
- Tests run in Vitest's node environment (no jsdom). They are pure `*.test.ts` files colocated in `src/lib` and `src/api`, plus `renderToStaticMarkup` for components. New tests follow the same style: pure functions, with no DOM or hook rendering.

## Design decisions

### URL shape (resolves the feature.md open question)

```
?tree=<t>&node=<mainFocus>&side=<anchor>[&sideNode=<head>]
```
- `side` present means the side chat is open. The value is the **anchor** (the main-chat node focused when it was opened). It can be `''` for the tree root, which is written as `side=`, so use `params.has('side')` rather than truthiness.
- `sideNode` is the side chat's **head**: the latest node it created. It is absent until the first successful send.
  - Sent means `sideNode` is present.
  - The parent of the next side message is `head ?? anchor`.
  - "Open in main chat" is enabled only when the head is present and the chat is not streaming.
- Validation in `readUrlState`: `sideNode` is kept only if it is a strict descendant of `side` (`isSameOrDescendant(head, anchor) && head !== anchor`). Otherwise it is dropped. `side`/`sideNode` are ignored when `tree` is absent.
- List seam: parse with `params.getAll('side')` / `getAll('sideNode')`, but read only index 0 for now. A future list writes aligned pairs, with an empty `sideNode=` for unsent entries. State type:
  ```ts
  export interface SideChatState { anchor: string; head: string | null }
  export interface UrlState { tree: string | null; node: string; side: SideChatState | null }
  ```
  A future `sides: SideChatState[]` replaces `side` without changing the URL grammar.
- `/` stays unescaped (same `%2F` replace as today).

### History semantics
- Open (Ask aside): **push**. Back closes the side chat.
- Head update after a side `done`: **replace**. Turns inside the side chat do not flood history.
- Open in main chat: **push** `{ node: head, side: null }`. Back returns to "main at old focus, side open".
- Close: **push** `{ side: null }`.
- Tree change: `navigate` clears `side` when `tree` changes and `side` is not given explicitly (mirrors the existing `node` reset).
- A move or delete in the graph remaps the side ids with **replace** (see step 8).

### Chat core extraction (no fork)
- A new hook, `useChatSession`, owns the draft, pending state, model choice, abort, `send`, `stop`, `quote`, the `streaming` flag and the cache seeding.
- It is parameterised by `parentId` (where to send) and an `onSent(nodeId)` callback. The main chat passes `onSelectNode`. The side chat passes a replace-navigate of `sideNode`. The side chat therefore never calls the main `onSelectNode`.
- A new presentational component, `ChatThread`, renders the `.chat-scroll` body: the messages, the pending `Exchange`, and the empty and error slots.
- Both `ChatView` (main) and `SideChatView` compose the hook, `ChatThread`, `SelectionActions` and `Composer`. Only the headers and actions differ.

### Seeding the quote
- The selection text is not put in the URL (it can be up to 50k characters). `App` holds `sideSeed: { nonce: number; text: string } | null`.
- `SideChatView` takes `seed` and applies `appendQuote(draft, seed.text)` whenever `seed.nonce` changes, then calls `composer.focusEnd()`.
- After a reload the draft is empty. The side chat still reopens on its anchor or head. Persisting the draft is out of scope.
- Ask aside while a side chat is already open:
  - Same anchor as the current main focus: append the quote to the existing side draft (new nonce, no URL change).
  - Different anchor: push a new `side` (a fresh side chat keyed by anchor). Nodes the old side created stay in the tree.
  - While the side chat is streaming, the **Ask aside** action is left out of the main chat's action list, so the running stream is never killed by accident.

### What the side panel shows
- `useChain(tree, head ?? anchor)`, then `sideThread(chain, anchor)`. The panel shows only the nodes strictly **after** the anchor (for anchor `''`, all of them), so it holds the side conversation, not the main context.
- The header shows the anchor as context ("Aside from `<anchor name|root>`"), a **Open in main chat** button and a **Close** button.
- Before the first send, the empty state reads: "Ask a side question. The main chat stays where it is."

### Parallel streaming and busy
- `App` keeps `mainStreaming` and `sideStreaming` and passes `busy = mainStreaming || sideStreaming` to the graph.
- `SideChatView` is keyed by `` `${tree.id}:${anchor}` ``, so a new anchor or tree gives a fresh session. Unmounting aborts its stream through the hook's cleanup, and the hook's `finally` reports `onStreamingChange(false)`.
- **Close while streaming** aborts the side stream (same as Stop). No node is created, per the contract. **Open in main chat** is disabled while streaming.

### Error handling (per contract)
- `ApiError` gains `readonly code?: ConflictCode`. `errorOf` reads `body.code` when it is one of the two known values.
- A new pure helper, `lib/chat-errors.ts` `describeError(error): { message: string; kind: 'busy-structural' | 'busy-streaming' | 'node-missing' | 'other' }`:
  - 409 + `tree_busy_structural`: "Nodes are being moved or deleted. Try again in a moment." The draft is kept, which is the existing hook behaviour.
  - 409 + `tree_busy_streaming` (graph move/delete while another tab streams): "An answer is still streaming. Try again when it finishes."
  - 404 whose message starts with `Node not found:`: `node-missing`.
  - Anything else: `errorMessage(error)`.
- `ErrorNote` gets an optional `message?: string` override. Both chats and the graph pass `describeError(e).message`.
- Side chat, 404 on send (the anchor or head was moved or deleted between turns): the pending error shows the message "The node this side chat branches from no longer exists (moved or deleted)." and a **Close side chat** button. The draft is kept.
- Side chat, 404 on the chain query (for example after a reload): the empty state shows the same message and a **Close side chat** button. There is no crash, and "Open in main chat" is disabled.
- Main chat: behaviour is unchanged, apart from the friendlier 409 text.

## Files to create / change (ordered)

### 1. `web/src/api/types.ts` and `web/src/api/client.ts`: error code
- `types.ts`: `export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';` plus `export interface ErrorBody { error: string; code?: ConflictCode; details?: unknown }`, mirroring `contracts/errors.ts`.
- `client.ts`:
  - `ApiError` constructor becomes `(status, message, code?: ConflictCode)`.
  - `errorOf` parses the body as `ErrorBody` and passes `code` only if it is a known value.
  - `sendMessage` is otherwise unchanged. SSE `error` events stay `ApiError(500, message)`.
- Tests, `web/src/api/client.test.ts`:
  - A 409 with `{error, code:'tree_busy_structural'}` becomes `ApiError` with `.status === 409` and `.code === 'tree_busy_structural'`.
  - A 409 without `code` has `code` undefined (backward compatible).
  - An unknown `code` string is ignored.

### 2. `web/src/lib/chat-errors.ts` (new) and `web/src/lib/chat-errors.test.ts` (new)
- `describeError(error: unknown)` as specified above. `isNodeMissing(error)` is a convenience helper.
- Tests: each branch (409 structural, 409 streaming, 409 without code falls back to the server message, 404 node missing, a plain `Error`, a non-Error value).

### 3. `web/src/components/ui/ErrorNote.tsx`
- Add an optional `message?: string` prop, used instead of `errorMessage(error)` when it is given. Otherwise unchanged.

### 4. `web/src/lib/url-state.ts` and `web/src/lib/url-state.test.ts`
- Add `SideChatState` and extend `UrlState` with `side: SideChatState | null`.
- `readUrlState`: parse `side`/`sideNode` as described, validate the head as a descendant of the anchor, and ignore both when `tree` is absent.
- `writeUrlState`: write `side` whenever `state.tree && state.side`, and `sideNode` when the head is not null. Order: `tree`, `node`, `side`, `sideNode`.
- `useUrlState.navigate`:
  - If `next.tree` differs from the current tree and `next.side === undefined`, set `merged.side = null`.
  - Type: `navigate(next: Partial<UrlState>, replace?)` (unchanged signature).
- Add pure helpers so App logic stays testable:
  - `openSide(state, anchor): Partial<UrlState>` returns `{ side: { anchor, head: null } }`.
  - `advanceSide(state, nodeId): Partial<UrlState>` returns `{ side: { ...side, head: nodeId } }`. It returns `{}` if the side is closed or the anchor no longer matches (a stale completion).
  - `promoteSide(state): Partial<UrlState> | null` returns `{ node: head, side: null }`, or `null` when there is no head.
  - `closeSide(): Partial<UrlState>` returns `{ side: null }`.
  - `remapSideAfterMove(side, moved)` and `remapSideAfterDelete(side, ids)`:
    - Move: apply `afterMove` to both the anchor and the head.
    - Delete: if the anchor was deleted, return the side unchanged, so the panel shows the node-missing state. If only the head was deleted, set head to `afterDelete(head, ids)`, or to `null` if that equals the anchor or leaves the anchor's subtree.
- Tests (extend the existing file):
  - Existing tests are updated to expect `side: null`.
  - Round-trip: `side` + `sideNode`, `side=` for the root anchor, `sideNode` omitted when the head is null.
  - `sideNode` that is not a descendant of `side` is dropped. `sideNode` equal to `side` is dropped.
  - No `tree` means no `side`.
  - Slashes stay unescaped.
  - `openSide`, `advanceSide` (including a stale anchor), `promoteSide` (null when unsent), `closeSide`.
  - Both remap helpers: anchor moved, head moved, the anchor's ancestor moved, anchor deleted, head deleted.
- The tree-switch-clears-side rule is tested by extracting `mergeUrlState(current, next): UrlState` as a pure function from `navigate`, and testing that.

### 5. `web/src/lib/side-chat.ts` (new) and `web/src/lib/side-chat.test.ts` (new)
- `sideThread(chain: ChainNode[], anchor: string): ChainNode[]`: the nodes after the anchor. For anchor `''` it returns the whole chain. If the anchor is not in the chain (inconsistent state), it returns `[]`.
- `sideParent(side: SideChatState): string`: `head ?? anchor`.
- `canPromote(side, streaming): boolean`: `head !== null && !streaming`.
- Tests for all three.

### 6. `web/src/components/chat/useChatSession.ts` (new): the extracted chat core
Moved verbatim from `ChatView.tsx` where possible:
- `Pending`, `MODELS_KEY`, `loadModels`, the model-choice filtering, `changeModels`.
- State and refs: `draft/setDraft`, `pending/setPending`, `abort`, `composer` (the `ComposerHandle` ref), `streaming`.
- The abort-on-unmount effect.
- `send()`. It takes the parent from `options.parentId` at call time (a ref, so the callback is stable). On `done` it:
  - seeds `keys.chain(tree, nodeId)` from `keys.chain(tree, parentId)`,
  - awaits `invalidateQueries(keys.tree)`,
  - calls `setPending(null)`,
  - calls `options.onSent(nodeId)`.
  Error and abort handling is unchanged: the draft is kept, and the error is set unless the stream was aborted.
- `quote(text)` (appendQuote plus focusEnd), `appendToDraft(text)` (for the side seed, same as quote), `stop()`, `dismissError()`.
- `onStreamingChange` is reported from inside `send` exactly as today.
- Signature:
  ```ts
  useChatSession(options: {
    treeId: string;
    parentId: string;
    onSent: (nodeId: string) => void;
    onStreamingChange: (streaming: boolean) => void;
  }): ChatSession
  ```
- The scroll handling (stick-to-bottom) moves into `ChatThread`.
- The model choice stays per instance and is read from and written to the same localStorage key. The two panels do not live-sync a change made in the other panel until remount. This is acceptable and documented in a comment.
- Optional pure extraction for tests: `applyChunk(pending, chunk)` and `applyAttachment(pending, event)` in the same file. This is not needed if it would only restate `applyAttachmentEvent`.

### 7. `web/src/components/chat/ChatThread.tsx` (new)
- Props:
  - `treeId`, `messages: ChainNode[]`, `pending: Pending | null`, `showPending: boolean`, `currentId?: string`, `onSelectNode?: (id) => void` (renders the `node-link`; plain text when absent), `onDismissError`.
  - `empty: ReactNode` (the empty-state slot) and `error: ReactNode | null` (the chain-error slot).
  - `scrollerRef` (so the parent can pass it to `SelectionActions`) and `scrollKey` (resets stick-to-bottom, today's `currentId` effect).
  - `pendingFooter?: (error) => ReactNode` (the side chat adds the Close button for node-missing).
- Contains today's L204-273 markup and the scroll/stick-to-bottom effects. The pending `ErrorNote` uses `describeError(...).message`.

### 8. `web/src/components/chat/ChatView.tsx`: main chat refactor
- Use `useChatSession({ treeId, parentId: currentId, onSent: onSelectNode, onStreamingChange })`, then render the crumbs header, `ChatThread`, `SelectionActions`, the pending-elsewhere notice and `Composer`. There is no behaviour change in the main flow.
- New optional props: `onAskAside?: (text: string) => void` and `askAsideEnabled?: boolean`.
- `selectionActions`: `[{ id:'quote', … }, …(onAskAside && askAsideEnabled ? [{ id:'aside', label:'Ask aside', run: onAskAside }] : [])]`.
- The existing 404 "Go to root" path is kept.

### 9. `web/src/components/chat/SideChatView.tsx` (new)
- Props:
  - `tree: TreeDetail`, `side: SideChatState`, `seed: { nonce: number; text: string } | null`.
  - `onAdvance(nodeId)`, `onPromote()`, `onClose()`, `onStreamingChange(streaming)`.
- `useChatSession({ treeId, parentId: sideParent(side), onSent: onAdvance, onStreamingChange })`.
- `useChain(tree.id, sideParent(side))`, then `sideThread(...)`.
- Seed effect: when `seed?.nonce` changes, call `session.appendToDraft(seed.text)`.
- Header (`.chat-header.side-header`):
  - "Aside from `<name or root>`".
  - **Open in main chat**, a `Button`, `disabled={!canPromote(side, streaming)}`. Its title explains why: "Send a question first" or "Wait for the answer to finish".
  - **Close**, an icon button with an aria-label. It calls `onClose`, and unmounting aborts any stream.
- `ChatThread` with no `onSelectNode` (side nodes are shown as plain names), `currentId = side.head ?? undefined`, and `scrollKey = side.anchor`.
- `SelectionActions` with only `[{ id:'quote' }]` and `resetKey = side.head`. Ask aside is never offered here.
- Chain 404, or a pending error where `isNodeMissing`: the node-missing message plus a **Close side chat** button. `Composer` stays (the draft is kept), but sending remains possible only as a retry.
- `Composer` with `target = sideParent(side)`.
- No `pendingElsewhere` notice. The side parent only changes through its own sends or through a remap.

### 10. `web/src/components/graph/GraphView.tsx`: structural-change callback
- Add an optional prop `onNodesChanged?: (change: { kind: 'move'; moved: Record<string,string> } | { kind: 'delete'; ids: string[] }) => void`. Call it in the delete and move `onSuccess`, next to `onCurrentChange`.
- The action error `ErrorNote` uses `describeError(error).message`. That shows the friendly `tree_busy_streaming` text when another tab is streaming.
- `busy` semantics are unchanged (it is already a prop).

### 11. `web/src/lib/layout.ts` and `web/src/lib/layout.test.ts`: the fourth column
- New constants: `SIDE_WIDTH_KEY = 'otago.side-width'` and `SIDE_MIN_WIDTH = CHAT_MIN_WIDTH`.
- `defaultSideWidth(viewport) = Math.max(CHAT_MIN_WIDTH, Math.round(viewport * 0.3))`.
- `clampChatWidth(width, viewport, sidebar, reserved = 0)`: max becomes `viewport - sidebar - GRAPH_MIN_WIDTH - reserved`. The default keeps the existing callers and tests valid.
- `clampSideWidth(width, viewport, sidebar)`: range `[SIDE_MIN_WIDTH, max(SIDE_MIN_WIDTH, viewport - sidebar - GRAPH_MIN_WIDTH - CHAT_MIN_WIDTH)]`.
- `usePaneLayout(sideOpen: boolean)`:
  - Adds `sideWidth`, `setSideWidth` and `resetSideWidth`, persisted like the chat width.
  - When `sideOpen`, `chatWidth` is clamped with `reserved = sideWidth`. The side keeps its stored width, and the main chat shrinks first down to its minimum, while the graph keeps `GRAPH_MIN_WIDTH`.
- Tests:
  - `clampChatWidth` with `reserved`.
  - `clampSideWidth` in range, at the minimum, leaving room for graph plus chat, on a tiny viewport.
  - `defaultSideWidth`.
  - The existing tests still pass unchanged.

### 12. `web/src/App.tsx`: wiring
- State:
  - `const [mainStreaming, setMainStreaming]` and `const [sideStreaming, setSideStreaming]` replace `streaming`.
  - `const [sideSeed, setSideSeed] = useState<{ nonce; text } | null>(null)`.
- `const layout = usePaneLayout(url.side !== null && tree.data != null)`.
- Callbacks:
  - `askAside(text)`: if `url.side?.anchor === url.node`, set the seed only. Otherwise `navigate(openSide(url, url.node))` (push), then set the seed.
  - `advanceSide(nodeId)`: `navigate(advanceSide(readUrlState(location.search), nodeId), true)`. Read the live URL, not a stale closure.
  - `promoteSide()`: `const next = promoteSide(url); if (next) navigate(next)`.
  - `closeSide()`: `navigate(closeSide())`, then `setSideStreaming(false)` as a safety net, since the hook also reports false on abort.
  - `onNodesChanged(change)`: if `url.side`, remap it with the helpers and `navigate({ side }, true)` if it changed.
- Tree switch: `selectTree` already navigates `{ tree, node: '' }`, and `navigate` now clears `side` too. Also call `setSideSeed(null)`.
- `GraphView`: `busy={mainStreaming || sideStreaming}` and `onNodesChanged={onNodesChanged}`.
- `ChatView`: `onStreamingChange={setMainStreaming}`, `onAskAside={askAside}`, `askAsideEnabled={!sideStreaming}`.
- Root element:
  - The class list adds `url.side && tree.data ? 'app-side-open' : ''`.
  - The style adds `'--side-w': `${layout.sideWidth}px``.
- A new pane after `section.chat-pane`, rendered only when `url.side && tree.data`:
  ```tsx
  <section className="chat-pane side-pane" aria-label="Side chat">
    <Splitter value={layout.sideWidth} min={SIDE_MIN_WIDTH}
      max={clampSideWidth(Infinity, layout.viewport, layout.sidebarWidth)}
      onChange={layout.setSideWidth} onReset={layout.resetSideWidth} onDragChange={setResizing} />
    <SideChatView key={`${tree.data.id}:${url.side.anchor}`} … />
  </section>
  ```
- The main chat `Splitter` max becomes `clampChatWidth(Infinity, viewport, sidebarWidth, sideOpen ? sideWidth : 0)`.
- Source and attachment viewers stay in the main chat pane, even when opened from the side chat. That is acceptable for v1.
- `sideStreaming` must also reset when the side unmounts because of a tree change or back navigation. The hook's `finally` covers this, and `closeSide` resets it explicitly too.

### 13. `web/src/styles/base.css`: layout
- `.app.app-side-open { grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--chat-w) var(--side-w); }`. The existing 180 ms column transition applies.
- `.app-side-open .chat-pane`: the main chat is no longer at the right edge, so screen-centre padding makes no sense. Override with `--chat-pad-l: max(var(--chat-gutter), calc((var(--chat-w) - var(--chat-col)) / 2)); --chat-pad-r: var(--chat-pad-l);`.
- `.side-pane { --chat-w: var(--side-w); }`. It inherits `.chat-pane` styles and the same pane-centred padding as above.
- `.side-header` has a flex row: the title on the left, the actions on the right. It reuses the existing `.chat-header` tokens.
- Mobile block (`max-width: 800px`):
  - `.app.app-side-open { grid-template-columns: 1fr; grid-template-rows: auto 50vh auto auto; }`.
  - `.side-pane` gets the same `min-height: 80vh`, `border-top`, no `border-left`, and gutter padding as `.chat-pane`. The splitters are already hidden.
- No colours or new tokens: only existing CSS variables are used.

## Step ordering

1. Steps 1-3 (API error code, `chat-errors`, `ErrorNote`), with their tests.
2. Steps 4-5 (URL state and side-chat pure helpers), with their tests.
3. Steps 6-8 (extract `useChatSession` and `ChatThread`, refactor `ChatView`). Check that the main chat behaves exactly as before, then commit point (for the developer).
4. Step 11 (layout helpers), with tests.
5. Steps 9, 10, 12, 13 (the `SideChatView`, the graph callback, App wiring, CSS).
6. Run `cd web && pnpm test`, `cd web && pnpm exec tsc --noEmit`, and `cd web && pnpm lint`. For formatting use `cd web && pnpm format`, and never format by hand.
7. Manual end-to-end check against a server that has the server plan implemented (see the test plan). Parallel streaming needs the server's shared lock. Against the old server, the second stream gets a 409 without `code`, and the UI shows the server message.

## Test plan

### Unit (Vitest, node env)
- `api/client.test.ts`: `ApiError.code` parsing (known, missing, unknown).
- `lib/chat-errors.test.ts`: every `describeError` branch.
- `lib/url-state.test.ts`:
  - read/write round-trips (root anchor, head omitted, invalid head dropped, no tree).
  - `mergeUrlState`: a tree switch clears `side` and `node`. An explicit `side` in a tree switch is honoured. A node-only change keeps `side`.
  - `openSide`, `advanceSide` (stale anchor gives `{}`), `promoteSide` (null when unsent), `closeSide`.
  - `remapSideAfterMove` and `remapSideAfterDelete`.
- `lib/side-chat.test.ts`: `sideThread` (root anchor, middle anchor, anchor missing), `sideParent`, `canPromote`.
- `lib/layout.test.ts`: `clampChatWidth` with `reserved`, `clampSideWidth`, `defaultSideWidth`. The existing cases are unchanged.
- The existing `sse.test.ts`, `quote.test.ts` and `popup-position.test.ts` are unchanged and must pass.

### Manual (browser, `pnpm dev` plus the server)
1. Select text in the main chat. The popup shows **Quote** and **Ask aside**. Ask aside opens the 4th column with a `> quote` draft, and the URL gains `side=<main node>`. The graph stays visible.
2. Send in the side chat. It streams in the side panel, the URL gains `sideNode=<new id>`, the main `?node=` is unchanged, and the graph shows the new child of the anchor.
3. Send a second side turn. The new node is a child of the first side node, and the side panel lists both turns only (no main context).
4. Stream the main and side chats at the same time, including from the same parent. Both finish, two distinct nodes are created, the graph is busy until both are done, and move/delete/drag stay disabled throughout.
5. Selecting text inside the side chat offers **Quote** only.
6. **Open in main chat** is disabled before the first send and while streaming. After a send, clicking it moves the main focus to the side head and closes the side panel. Back reopens the side panel at the old main focus.
7. Close with sent nodes: the nodes stay in the graph. Close with nothing sent: no node is created. Close while streaming aborts the stream, and no node is created.
8. Reload with the side open (sent and unsent): the panel reopens on the right chain, with an empty draft.
9. Tree switch: the side closes, and the URL has no `side`.
10. Between turns, move the anchor via the graph: the side ids are remapped and the next send works. Delete the anchor: the side shows the node-missing state with **Close side chat**. Edit the URL to a nonexistent `side`: same empty state, no crash.
11. Start a move/delete from another tab while this tab streams: a 409 `tree_busy_streaming` shows the friendly text in the graph. Send during a move/delete (hard to time; can be simulated by a mocked fetch in the unit test): a 409 `tree_busy_structural` shows in the chat panel, and the draft is kept.
12. Narrow the window below 800 px: the side chat stacks as an extra row and stays usable.
13. Main focus changes while the side is open: the side stays on its anchor.

## Extension seams (not implemented)
- Several side chats: `UrlState.side` becomes `sides: SideChatState[]`, parsed from the existing aligned `getAll('side')` / `getAll('sideNode')`. `SideChatView` is already self-contained per `SideChatState`.
- A side chat opened without a selection: `seed` is optional, and `openSide` does not need text.
- A shared live model choice across panels: lift `loadModels` and `changeModels` into a small context later.

## Not in scope
- Hand-written or generated API types beyond the small `ConflictCode`/`ErrorBody` mirror in `api/types.ts`. There is no codegen in this repo, so there is no regeneration command.
- Persisting unsent side drafts across reloads.
- A dedicated mobile UX.
