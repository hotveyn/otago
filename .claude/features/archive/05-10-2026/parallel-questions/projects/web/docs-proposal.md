# parallel-questions — proposed doc changes (web plan step 11)

Not applied. The implementer must not edit the root `README.md` / `CLAUDE.md`; the developer
reviews and applies these hunks by hand. Line numbers refer to the files at commit `5c56186`.
They complement `projects/server/docs-proposal.md` (apply both; the server one adds the README
"Parallel questions" feature bullet and the server architecture lines, and leaves the CLAUDE.md
Web section to this proposal).

---

## `README.md`

### Features: UI details (after the server's new "Parallel questions" bullet, near line 23)

```diff
 - **Parallel questions.** …(server proposal)…
+- **Pending nodes.** Every question in flight is a box with a marching dashed outline under its node, titled with the question. Click it (or focus it and press Enter) to open its chat with the live answer; press Esc twice on a running box to cancel it. A failed answer turns red: open it to **Retry** (same text and files) or **Dismiss**. While answers run, structural edits are paused: the graph toolbar shows "N answering · Show…", which lists the running answers with **Open** / **Cancel** / **Cancel all**; a refused move, delete, rename, undo or tree rename offers to run again once nothing blocks it. The tree list shows a badge for trees with running answers and a red dot for failed ones.
+- **Several asides.** Opening a new aside sends the previous one to the background; it keeps answering and is reopened from its pending box.
 - **Graph view.** Pan, zoom and click around the tree. Drag a node onto another node to move it.
```

### Undo bullet (line 29)

```diff
-- **Undo.** Press Ctrl+Z (Cmd+Z on macOS) in the graph to undo the last move or delete. History is per tree, kept in the browser tab (sessionStorage, last 50 actions). No redo. Text fields keep their normal undo.
+- **Undo.** Press Ctrl+Z (Cmd+Z on macOS) in the graph to undo the last move or delete. History is per tree, kept in the browser tab (sessionStorage, last 50 actions). No redo. Text fields keep their normal undo. While answers are running, undo opens the list of running answers instead.
```

---

## `CLAUDE.md`

### Web (lines 51-55)

```diff
 ### Web (`web/src`)
-- React 19 + Vite, TanStack Query for server state (`api/queries.ts`, `api/client.ts`), SSE parsing in `api/sse.ts`, React Flow + dagre for the graph (`components/graph/`).
-- Navigation state lives in the URL (`lib/url-state.ts`: `?tree=&node=&side=&sideNode=`), synced via `useSyncExternalStore`; tree edits update it through `afterMove`/`afterDelete` in `lib/tree.ts`.
+- React 19 + Vite, TanStack Query for server state (`api/queries.ts`, `api/client.ts`), SSE parsing in `api/sse.ts`, React Flow + dagre for the graph (`components/graph/`).
+- In-flight questions (contract `.claude/features/parallel-questions/contracts/`): ONE app-wide SSE per tab, a `fetch` + `readSse` reconnect loop in `api/question-events.ts` (snapshot first, 45 s watchdog on pings, backoff with jitter, reconnect on chunk gaps); `lib/question-sync.ts` wires it to the store, disconnects tabs hidden > 30 s and resyncs on visible/online. State is a pure reducer + selectors in `lib/questions.ts` (SSE copies always replace; 202 copies only insert unknown ids or a higher `attempt`; removed ids are tombstoned), held by `lib/question-store.ts` (created once in `main.tsx`, outside React). The store publishes to React at most once per animation frame (`getSnapshot`), while lifecycle listeners read `getState()` synchronously. Every hook goes through `useStoreSelector` + `createCachedSelector` (stable references are required by `useSyncExternalStore`). The graph never subscribes to stream text; only the focused panels do (`useQuestionView`).
+- Chat panels = composer + focus: `components/chat/useComposer.ts` (draft, files, models; sends via `store.ask`, gets the draft back if the send fails before its 202; drafts survive remounts in `lib/draft-stash.ts`) and `useInFlight.ts` (the panel's focused question or its newest send, Cancel/Retry/Dismiss). `components/QuestionEffects.tsx` handles lifecycle side effects (focus a just-accepted question, refresh the tree and follow a saved one, notices via `lib/notices.ts`).
+- Navigation state lives in the URL (`lib/url-state.ts`: `?tree=&node=&q=&side=&sideNode=&sideQ=`; ids read from the URL are normalized to NFC), synced via `useSyncExternalStore`; tree edits update it through `afterMove`/`afterDelete` in `lib/tree.ts`. `q`/`sideQ` = the in-flight question a panel shows; `lib/question-focus.ts` `reconcileFocus` keeps them consistent with the store (drop unknown, follow remapped parents, follow a saved answer to its node). Async handlers always read the live URL (`readUrlState(location.search)`).
+- Pending boxes: `layoutTree(title, nodes, ghostParent, pending)` places them after a parent's real children (`__q__:<key>` flow ids; the key is the outbox id for this tab's sends, so a box keeps its identity across the 202). Relayout happens on add/remove/remap/label only, never on chunks or status changes. A 409 `tree_busy_streaming` (its `details` list the blockers, read with `lib/blockers.ts`) opens `components/graph/BlockersDialog.tsx` via `BlockersContext`, with the refused action offered again.
 - Pure logic is kept in `lib/*.ts` with colocated `*.test.ts`; components stay thin.
-- Tree undo (Ctrl+Z): history lives in `lib/undo-history.ts` (per-tree sessionStorage stack, cap 50), driven by `components/graph/useTreeUndo.ts`; shortcut/focus rules in `lib/keyboard.ts`. `HistoryEntry` is an open discriminated union (`move`, `delete`); add new undoable actions as new members. Every entry holds its own inverse data. After any id-changing response, remap the whole stack by prefix (`old` / `old/…` → `new…`). Undo errors: 409 keeps the entry, 400/404 drop it.
+- Tree undo (Ctrl+Z): history lives in `lib/undo-history.ts` (per-tree sessionStorage stack, cap 50), driven by `components/graph/useTreeUndo.ts`; shortcut/focus rules in `lib/keyboard.ts`. `HistoryEntry` is an open discriminated union (`move`, `delete`); add new undoable actions as new members. Every entry holds its own inverse data. After any id-changing response, remap the whole stack by prefix (`old` / `old/…` → `new…`). Undo errors: 409 keeps the entry, 400/404 drop it. While answers run (`busy`), Ctrl+Z and a busy 409 open the blockers dialog (`onBusy`) instead of the toast.
+- Display text is cut by graphemes (`lib/text.ts`, `Intl.Segmenter`), never with `slice`; node ids are shown with `components/ui/IdPath.tsx` (`<bdi>` per segment) and labels with `dir="auto"`.
```
