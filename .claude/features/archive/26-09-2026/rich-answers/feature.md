# Rich answers: attachments, Mermaid diagrams, smart tables

## Summary

Answers today are Markdown text only. This feature lets the agent produce richer output:

- **Attachments**: files of any type saved through a server-side tool into the node folder.
- **Mermaid diagrams**: rendered from fenced blocks in the answer.
- **SVG images**: delivered as attachments and shown inline.
- **Tables**: CSV/TSV rendered as tables, with sort, filter and CSV export.

Files stay plain files in the tree, so the whole thing remains git-friendly.

## Goals

1. **`save_attachment` tool.** Add a server-provided agent tool. It saves a file for the answer being generated, from either:
   - inline content (`utf8` or `base64`), or
   - a URL the server downloads.
2. **Storage.** Keep attachments inside the node folder (`<node>/attachments/`), so they move and get deleted together with the node.
3. **Atomic with the node.** Attachments are written only when the answer succeeds.
4. **Show attachments in the chat.** Each answer shows its attachments:
   - preview for known types (images incl. SVG, CSV/TSV, text/code, PDF);
   - download for every type.
5. **Mermaid.** Render ```` ```mermaid ```` fenced blocks as diagrams.
6. **Tables.**
   - Render CSV/TSV (fenced ```` ```csv ````/```` ```tsv ```` blocks and `.csv`/`.tsv` attachments) as tables.
   - All tables, including GFM Markdown tables: click-to-sort columns, quick row filter, "Export CSV".
7. **Agent awareness.** The agent knows about the capabilities (system prompt) and can see earlier attachments in the chain (names listed in the transcript, readable with `Read`).

## Non-goals

- Code execution / sandbox for generating files (see Future considerations).
- Inline ```` ```svg ```` blocks in the answer text. SVG is attachment-only.
- Vega-Lite or other data-chart libraries; interactive or zoomable charts.
- The user attaching files to their own questions.
- Editing, renaming or deleting individual attachments from the UI (they live and die with the node).
- Promoting an attachment into `sources/`.
- Changes to how answers cite sources.

## Actors

- **Learner**: the single local user reading answers in the web UI.
- **Agent**: Claude via the Agent SDK. It generates answers and calls `save_attachment`.
- **Server**:
  - owns the filesystem and the tool implementation;
  - downloads URLs;
  - streams answers and attachment events to the UI.

## Main scenarios

1. **Chart as a diagram.** Learner asks "draw the ownership flow".
   - The agent answers with a ```` ```mermaid ```` block.
   - The UI renders it as a diagram, with a toggle to see the source.
2. **SVG illustration.** The agent calls `save_attachment({ name: "memory-layout.svg", content: "<svg…>", encoding: "utf8" })` and references it in the answer.
   - The UI shows the SVG inline (sanitized) plus a download link.
3. **Data table / file.** The agent saves `benchmarks.csv`.
   - The UI renders it as a sortable, filterable table with "Export CSV" and "Download".
   - A GFM table in the answer text gets the same sort, filter and export controls.
4. **Binary file from base64.** The agent saves a small PNG/PDF with `encoding: "base64"`. The UI previews (image/PDF) or offers download (other types).
5. **File from a URL.** The agent found an image or document via WebSearch and calls `save_attachment({ name, url })`.
   - The server downloads it and stores it as an attachment.
6. **Streaming.** While the answer streams, the UI shows each saved attachment as soon as the tool call completes ("saving…" → ready). Final state appears after `done`.
7. **Branching context.** A follow-up question under that node:
   - The transcript lists the parent's attachments (`<node-id>/attachments/<name>`).
   - The agent can `Read` them (e.g. refine a CSV).
8. **Node management.** Moving a node moves its attachments; deleting removes them. Git history is the backup, as for nodes.

## Edge cases

- **Answer fails or client disconnects.** No attachments are written; nothing is left behind.
  - Staging lives in a temp dir inside the tree (same device, cleaned up on failure).
- **Name safety.**
  - Attachment names are sanitized: no path separators or `..`, safe charset.
  - Two attachments with the same name in one answer → `-2` suffix. The tool result returns the final name, so the agent references the right one.
- **Reserved name.** `attachments` becomes a reserved folder name at every node level.
  - A child node must never be named `attachments` (`-2` suffix, as with `sources` at the root).
  - The hierarchy reader must never treat the folder as a node.
- **No size limit, any type** (user decision).
  - The implementation must still stream to disk rather than buffer whole files in memory.
  - The UI must not auto-preview huge files (preview threshold; download is always available).
- **URL download.**
  - Only `http`/`https`.
  - Timeout; follows a bounded number of redirects.
  - Failure returns a tool error to the agent (the answer continues) rather than failing the whole answer.
  - Name/extension from the tool input, falling back to `Content-Disposition` / URL path.
  - Private/loopback addresses: see Open questions.
- **Invalid base64 or empty content** → tool error to the agent; the answer continues.
- **Answer references a missing attachment** (typo, or the save failed): the UI shows a broken-attachment placeholder, not a crash.
- **SVG security.**
  - Rendered without script execution (sanitized, or via `<img>`).
  - External references blocked.
- **Mermaid render error** (invalid syntax, or partial while streaming): show the source code with an error note. Render only once the block is complete.
- **Malformed CSV** (ragged rows, quotes, BOM, `;` delimiter): best-effort parse; fall back to showing raw text.
- **Large tables.** Sorting/filtering stays responsive for a few thousand rows. Beyond a threshold, show the first N rows + "download full file".
- **Tree lock.** Attachment writes happen under the existing per-tree lock as part of the message request.
  - Node management stays blocked while streaming (409, unchanged).
- **Backward compatibility.** Existing nodes without `attachments/` render exactly as before. The `node.md` format is unchanged.

## Constraints (NFR)

- **Stack.** Backend Fastify + TypeScript; frontend React + Vite. Biome for lint/format; pnpm + turbo monorepo.
- **Filesystem is the only source of truth.** Attachments are plain files under the node folder, human-readable in git where the type allows.
- **The agent still cannot write files directly.**
  - `Write` / `Edit` / `Bash` stay denied.
  - The only write path is the server-implemented `save_attachment` tool (in-process SDK MCP tool).
  - The tool can only write into the staging area of the current answer.
- **Design.** Previews follow the existing light design: serif text, 3px corners, thin borders.
- **Tests.** All new endpoints and the tool are covered by integration tests with the agent mocked. Parsing helpers (CSV, sanitize) get unit tests.

## Future considerations (out of scope)

- **Code execution sandbox.** The agent will run Python/JS (matplotlib, pandas) to produce files and charts. Design `save_attachment` and the staging/commit pipeline so a sandbox can later emit files into the same staging area and attachment model:
  - no assumption that attachments come only from tool-call arguments;
  - the attachment record (name, type, size, origin) is source-agnostic.

## Open questions

1. **URL downloads to private/loopback addresses** (SSRF): block by default (proposed), or allow since the app is local-only?
2. **Preview thresholds** (e.g. images > 20 MB, tables > 5 000 rows, text > 2 MB): accept the proposed defaults in the plan, or specify?
3. **Unreferenced attachments.** Should attachments not referenced in the answer text still be listed under the answer? (Proposed: yes, always list all attachments of the node.)
