# Side chat (btw) from selected text

## Summary
A "by the way" side conversation. The user selects text in the main chat and picks **Ask aside** in the selection popup. A side-chat panel opens in the right-most column with the selection pre-quoted. Questions asked there create real nodes that branch from the node currently focused in the main chat. The main chat's focus does not change. A button in the side chat, **Open in main chat**, focuses the side branch's last node in the main chat and closes the side chat.

## Goals
- Ask a tangential question about a quoted fragment without moving the main chat's focus.
- The side chat can have several turns. Each turn is a child of the previous side node, forming a normal branch in the tree.
- The side chat and the main chat can stream at the same time.
- One click promotes the side branch to the main chat, and the side panel closes.
- The side chat survives reload and back/forward navigation.

## Non-goals
- Several side chats open at once. There is one side chat at a time.
- Opening a side chat without a text selection (e.g. from the graph).
- Merging or summarising the side answer back into the main chat.
- A dedicated mobile UX. The side chat only needs to stay usable in the existing stacked mobile layout.
- A new node.md format. Side nodes are ordinary nodes, and the quote is plain Markdown `> ` text in the user message.

## Actors
- **User**: a single local user in the browser.
- **Server**: Fastify API that streams answers and writes nodes.

## Main scenarios
1. **Open**: the user selects text in the main chat → the existing `SelectionActions` popup shows a new action, **Ask aside**, next to **Quote** → the side panel opens with the selection as a blockquote draft. It is anchored to the node focused in the main chat at that moment, called the *anchor*.
2. **Ask**: the user types a question and sends it → `POST /trees/:tree/messages` with `parentId = anchor` streams into the side panel → a new node is created → the side panel now tracks that node. The main chat's `?node=` is unchanged.
3. **Continue**: further questions in the side chat use the side chat's latest node as their parent.
4. **Parallel**: the main chat can stream at the same time, and so can the side chat.
5. **Open in main chat**: this sets the main focus (`?node=`) to the side chat's latest node and closes the side panel (removes `?side=`).
6. **Close**: the user closes the panel → any nodes it created stay in the tree and appear in the graph. If nothing was sent, nothing is created.
7. **Reload**: the URL carries the side-chat state, e.g. `?side=<nodeId>`, plus the anchor or unsent state as needed. Reloading reopens the side panel on that node's chain.

## Layout
- Normal layout: `sidebar | graph | chat`.
- Side chat open: `sidebar | graph | main chat | side chat`. The graph is not hidden. The main chat moves from the right edge to the inner position, and the side chat takes the right-most column. (This is our reading of the user's answer. See Open questions.)
- Closing the side chat restores the normal layout.

## Edge cases
- **Server concurrency**: today `TreeLocks` allows one request per tree and returns 409 otherwise. This must change so two message streams in the same tree can run at the same time. Structural ops (move/delete in `routes/nodes.ts`) must still be exclusive: they wait for or reject active streams, and no stream starts while a move or delete runs.
- **Same-parent race**: both chats send from the same parent at the same moment. Both children must be created with unique names. Node naming (Haiku kebab-case) plus `createNode` must not collide or overwrite.
- **Anchor deleted or moved** while the side chat is open or streaming, or its node is gone on reload: show a clear error or empty state in the side panel and don't crash. Node ids are paths, so a move changes the id.
- **Graph `busy`**: currently a single `streaming` flag disables move/delete/drag. It must be true when *either* chat is streaming.
- **Main focus changes** while the side chat is open: the side chat stays anchored to its own node and does not follow.
- **Selection inside the side chat**: the **Ask aside** action is not offered in the side panel. Only **Quote** is (into the side composer).
- **Open in main chat while the side chat is streaming**: disabled until the stream ends or is aborted.
- **Open in main chat with nothing sent**: disabled, because there is no node yet.
- **Stream error or abort** in the side chat: the error shows in the side panel, the draft is kept, and no node is created. Same behaviour as the main chat.
- **Empty or whitespace question**: Send is disabled. The server rejects text shorter than 1 character after trim.
- **Quote length**: reuse `isQuotable` and the existing limits. The total text is at most 50,000 characters, which the server validates.
- **Tree switch**: the side chat closes when the tree changes.
- **Narrow screens**: the side panel stacks as another row. No special UX.

## Constraints (NFR)
- Reuse the existing `SelectionActions`, `lib/quote.ts`, the chat rendering (`Exchange`, `Composer`) and the SSE client. Don't fork the chat logic. Extract a reusable chat core if needed.
- No database. State stays as plain files plus URL, as now.
- Keep the existing message API contract backward compatible. The side chat should need no new endpoint beyond the lock change.
- The server test suite (`server/test/*`) and web tests (Vitest) cover the new concurrency and the URL-state logic.

## Future considerations (out of scope)
The user named no specific future features. Keep these cheap anyway:
- The side-chat state is shaped so it can later become a list (several side chats) without an URL/state rewrite.
- The side-chat panel doesn't assume it was opened from a text selection, because the quote is optional input.

## Open questions
- Layout: we read "right-hand chat should be in centre column" plus "graph: nothing" as a 4th column (`graph | main | side`). Confirm, or say whether the graph should give up its column instead.
- The exact URL shape for the side state: `?side=<nodeId>` only, or also `?sideAnchor=` for the state before anything is sent. To be decided in plan.
- Lock policy for move/delete while a stream is active: reject with 409, as today, or queue. The default is to reject.
