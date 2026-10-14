# Parallel questions with pending nodes

## Summary
Today the web client allows only one in-flight question at a time, and that question is not visible in the tree graph. This feature lets the user ask many questions at once: send a message, go back to the graph, pick another node, and ask again while earlier answers are still generating. Each in-flight question appears in the graph as a **pending node** (animated dashed outline, titled with the user's question text). Multiple "ask aside" (side chat) conversations can also exist at once: opening a new aside sends the previous one to the background, and it can be reopened only by clicking its pending node in the graph.

In-flight questions are owned by the **server** (not the browser tab): they survive page reload/tab close, and the client re-attaches to them. Node names are generated **after** the answer, in the **language of the answer**, and folder names (= node ids) may contain Unicode letters.

## Goals
- Several questions can stream concurrently in one tree (main chat and/or side chats, any parents).
- Every in-flight question is rendered in the graph as a pending node under its parent: animated dashed border, title = user's question text (truncated).
- Multiple side chats: starting a new aside backgrounds the current one; a backgrounded aside is reopened by clicking its pending node.
- Clicking any pending node opens its own chat (main chat at that node, or the aside panel with that thread) with the live stream; the previously open chat goes to the background.
- In-flight questions keep generating when the client disconnects; after reload the client lists them and re-attaches to their streams (catching up on already-generated text).
- A pending question can be cancelled explicitly (button / Esc on the pending node / in its chat).
- Failed questions stay as a red "failed" node; clicking shows the error with **Retry** and **Dismiss**. Nothing is written to disk on failure.
- Node naming runs after the answer completes, sees question + answer, and produces a name in the answer's language.
- Folder names (node ids) may contain Unicode letters (e.g. Cyrillic), not only `[a-z0-9]`.

## Non-goals
- A cap on concurrent questions or a queue (no limit for now).
- Surviving a **server** restart: the in-flight registry is in-memory; a restart loses pending questions.
- Multi-tab sync as a guaranteed UX (see Future considerations), though the server registry should not prevent it.
- Browser/sound notifications on completion.
- Path-scoped locking: structural ops (move/delete/restore/rename) stay blocked with 409 while anything is pending in the tree.
- Renaming/migrating existing ASCII folders.

## Actors
- **Learner** (single local user) using the web UI.
- **Server** (`@otago/server`): owns in-flight question registry, streaming, naming, storage.
- **Agent** (Claude via agent SDK): answers and names nodes.

## Main scenarios
1. **Parallel main-chat questions.** User asks Q1 under node A. While it streams, user returns to the graph: a pending node "Q1 text…" with an animated dashed border appears under A. User selects node B, asks Q2. Both stream. When Q1 finishes, its pending node becomes a normal node with an AI-generated name in the answer's language.
2. **Multiple asides.** User opens an aside from node C and asks a question. Then opens a new aside from node D: the C-aside goes to the background (keeps streaming), its pending node is visible in the graph. Clicking the C-aside's pending node reopens that aside panel with its thread and live stream; the D-aside goes to the background.
3. **Open a pending node.** Clicking a pending main-chat node opens the main chat positioned at it, showing the question and the streaming answer.
4. **Reload.** User reloads the page mid-stream. The client fetches the list of in-flight questions for the tree, renders their pending nodes, and on opening one re-attaches to its stream, receiving the text generated so far plus new chunks.
5. **Cancel.** User cancels a pending question → generation is aborted, staging discarded, pending node removed.
6. **Failure.** Agent errors → pending node turns red (failed). Click → error message with Retry (re-sends the same question/files to the same parent) or Dismiss (removes it).
7. **Naming.** After the answer is done, the server asks the naming model for a 2–4 word name in the answer's language, sanitizes it to a Unicode kebab-case folder name, and creates the node.

## Edge cases
- **Pending under a pending node:** a follow-up can only be asked under a *created* node (a pending node has no id yet) — unless planning decides otherwise; asking from a pending/failed node is disabled.
- **Structural ops while pending:** move/delete/restore/rename return 409 `tree_busy_streaming` (unchanged); UI explains which pending questions block it and offers to cancel them. Undo (Ctrl+Z) of move/delete follows the same 409 rule (entry kept).
- **Client disconnect** no longer aborts generation (today it does). Only an explicit cancel aborts.
- **Re-attach** to a finished question: if it completed between list and attach, the client gets the final state (node id) and refreshes the tree.
- **Failed entries** live in the server registry until dismissed or retried (memory only; lost on server restart). Define retention so the registry cannot grow unbounded (e.g. completed entries dropped once the client acknowledged / after a TTL).
- **Uploads:** files are validated/staged before streaming starts (unchanged); a failed upload never creates a pending entry, or creates a failed one — planning decides, but no disk writes leak.
- **Unicode names:** normalize to NFC (macOS returns NFD from the filesystem), lowercase, allow Unicode letters + digits joined by `-`; reject path separators, `.`-prefixed, control chars, reserved names; keep `-2` collision suffix and soft-delete `.deleted-<epochMs>` suffix working (the `.` keeps trash folders non-slug). Collision checks must compare normalized forms. Ids in URLs are percent-encoded.
- **Mixed-language trees:** sibling uniqueness and sorting work regardless of script; existing ASCII nodes remain valid.
- **Naming failure** after a successful answer falls back to a name derived from the question (as today) — never loses the answer.
- **Pending title:** user's question text, single line, truncated; for file-only messages show the attached file names.
- **Side-chat backgrounding:** the URL (`side=`, `sideNode=`) reflects only the foreground aside; backgrounded asides are discoverable only via their pending node (and, after completion, via the created node as today).
- **Undo history** is unaffected by node creation; ids it holds stay valid since creation never renames existing nodes.

## Constraints (NFR)
- Filesystem remains the source of truth for *created* nodes; pending/failed state is in-memory server state only, never written to `trees/` (staging folders excepted, as today).
- Atomic node creation (staging → rename) unchanged.
- Per-tree readers–writer lock semantics unchanged; each in-flight question holds a shared lock for its whole lifetime (including after the client disconnects) until done/failed/cancelled.
- Pending node rendering must not re-layout the whole graph on every chunk (only on add/remove/status change).
- Re-attach must not duplicate text: chunk replay is by offset/sequence.
- Tests use `fakeAgent()`; no real SDK calls.
- Backward compatible with existing trees and node ids.

## Future considerations (out of scope, design must allow)
- **Multi-tab sync:** another tab should be able to list and attach to the same in-flight questions. The server registry + "list in-flight / attach by id" API must be tab-agnostic (no per-connection ownership), and multiple concurrent subscribers per question should be possible.
- **Notifications:** browser/sound notification when a background answer finishes or fails. Expose a clear completion/failure event the client can hook (e.g. a tree-level events stream or status change in the in-flight list).

## Open questions
- API shape for in-flight questions: start (returns id) + separate attach SSE, vs. current POST-SSE plus a re-attach endpoint; tree-level event stream vs. polling the in-flight list. (→ plan)
- Retention policy for completed/failed registry entries. (→ plan)
- Should a follow-up be allowed under a pending node (chaining to an uncreated parent)? Default: no.
- Exact Unicode slug rules (which categories allowed, max length) and URL encoding in `url-state.ts`. (→ plan)
- Should naming see the full answer or a truncated prefix (token cost)? (→ plan)
