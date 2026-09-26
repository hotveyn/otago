# Chat file attachments (per-node)

## Summary
The user can attach files to a chat message before sending it. Files are added with a picker button, by pasting from the clipboard (Cmd/Ctrl+V), or by drag-and-drop onto the composer. Attached files belong to the node created by that message. They are not tree-wide `sources/`. The agent can read them when answering this node and any follow-up in the same branch (descendants). Siblings and other branches never see them.

## Goals
- Attach up to 10 files to one message via picker, paste, or drag-and-drop.
- Files are stored inside the new node's folder (plain files, git-friendly, no DB).
- The agent reads them for the answer and for all descendant answers in that branch.
- The user message in the chat shows the attached files (name, type, size; preview/download where the kind supports it).
- Works in the main chat and the side chat (both use the shared chat composer/thread).

## Non-goals
- Attaching from a URL (see Future considerations).
- Editing, removing, or replacing files on an already-sent node.
- Promoting a node file to tree-wide `sources/`.
- Tree-wide visibility of node files.
- New file types beyond the list below.

## Actors
- **User**: a single local user in the browser.
- **Server**: Fastify API that streams answers, stores node files, runs the agent.
- **Agent**: Claude Agent SDK run with read access to the tree folder.

## Main scenarios
1. **Pick**: user clicks an attach button in the composer → OS file picker (accept = allowed types, multiple) → chips appear in the composer.
2. **Paste**: user pastes files (e.g. a screenshot, a copied file) into the composer → chips appear. Plain-text paste keeps working as today.
3. **Drag-and-drop**: user drags files over the composer → a drop-zone highlight → drop adds chips.
4. **Remove before send**: user removes a chip → it is not sent.
5. **Send**: user sends text + files → server validates, stores files for the new node, runs the agent with the files listed in the prompt → answer streams → node is created with the files in its folder. Files and node appear atomically (same staging-dir → node-dir rename as answers).
6. **Follow-up**: a later question in the same branch → the transcript lists the ancestor node's files, so the agent can Read them.
7. **Other branch**: a question on a sibling/other branch → those files are not in its chain and not listed.
8. **Reload**: the user message of a node shows its files after reload (listed by the nodes API).

## Allowed file types
- Sources set: `.md`, `.txt`, `.pdf`, and e-books `.epub`, `.fb2`, `.fb2.zip`, `.mobi`, `.azw`, `.azw3` (e-books get the same extracted-text `.md` companion as sources, so the agent can read them).
- Plus images: `.png`, `.jpg`/`.jpeg`, `.webp`, `.gif` (so pasted screenshots work). Images should be readable by the agent (Read tool supports images).
- One shared allow-list constant per project; server is the source of truth, the web `accept` mirrors it.

## Edge cases
- **Unsupported type** (picked, pasted, or dropped): rejected client-side with a clear message naming the file and the allowed types; the server rejects it too (400) if it slips through.
- **Too many files** (>10): client blocks adding more; server rejects with 400.
- **Too large**: per-file cap = existing sources cap (`MAX_SOURCE_BYTES`, 20 MB). Client warns early; server enforces (413/400). Total request size must be bounded too (10 × cap max).
- **Empty file (0 bytes)**: rejected.
- **Pasted image without a name** (clipboard gives `image.png`): server assigns a safe unique name; duplicates in one message get unique names (reuse `uniqueFileName`).
- **Unsafe names** (path traversal, unicode, very long): sanitized to the existing safe-name rules; never written outside the node folder.
- **Name clash with agent-saved attachments**: user files and agent files must not overwrite each other (separate folder, or a naming scheme).
- **E-book parse failure**: message is rejected with a clear error before the agent runs (same behaviour as sources upload), nothing is created.
- **Stream aborted / agent error**: no node is created and uploaded files are discarded with the staging folder.
- **Text optional?** Today `text` is required (min 1). Sending files with empty text: see Open questions.
- **Drag over the rest of the page**: dropping outside the composer must not navigate the browser to the file.
- **Concurrency**: main chat and side chat may both send with files at the same time; each uses its own staging folder.
- **Move/delete node**: files move/delete with the node folder (they live inside it). Descendants keep access after a move of the whole subtree; a node moved away from the owner's subtree loses access (chain-based).
- **Backward compatibility**: existing nodes have no user files; JSON-only message requests must keep working if the transport changes.

## Constraints (NFR)
- No database; files live in the node folder under `trees/`.
- Atomic: files + node.md appear together or not at all.
- Streaming (SSE) answer behaviour unchanged.
- Server-side validation is authoritative; never trust client type/size.
- Keep memory bounded: stream uploads to disk, do not buffer 10 × 20 MB in RAM.
- The global multipart plugin today has `files: 1`; the message route needs its own limits without loosening the sources upload route.

## Future considerations (out of scope)
- **Attach from URL**: the user pastes a link and the server downloads it into the node. Design the storage/validation path so a URL-sourced file goes through the same allow-list, size cap, naming and staging code (the existing `download.ts` / `downloadToFile` helper is a natural hook). The message contract should allow adding a `urls` field later without breaking clients.

## Open questions
- Allow sending files with empty text? (Suggestion: yes, with a default prompt like "See attached files", or keep text required.)
- Transport: multipart `POST /messages` (text + files in one request) vs upload-first to a staging endpoint then send IDs. To decide in `/feature:plan server`.
- Folder name for user files inside the node (e.g. `uploads/` vs sharing `attachments/` with a flag). Must be added to reserved node names.
