/**
 * CONTRACT SPEC (planning artifact) — feature `chat-file-attachments`. Owner: server.
 * Single source of truth for the data shape during planning. Not runtime code; no codegen exists
 * in this repo — the web mirrors these by hand (`web/src/api/types.ts`, `web/src/lib/chat-files.ts`).
 *
 * Files:
 *  - shared.ts      existing shapes reused unchanged (AttachmentInfo, AttachmentEvent, …)
 *  - user-files.ts  folder name, limits, allow-list, naming rules, UserFileInfo
 *  - messages.ts    POST /messages transport (JSON | multipart `payload` + `files`), empty-text
 *                   rule, SSE `done.files`, future `urls` seam
 *  - http.ts        chain `files` field, GET /trees/:tree/files, error codes
 *  - agent.ts       prompt layout + system-rule semantics (server-internal)
 *
 * Decisions (feature.md open questions):
 *  1. Transport: single multipart POST /messages → SSE; JSON still accepted when there are no files.
 *  2. Folder: `<node>/files/`, reserved node/root name.
 *  3. Empty text: allowed iff ≥ 1 file.
 */
export * from './agent';
export * from './http';
export * from './messages';
export * from './shared';
export * from './user-files';
