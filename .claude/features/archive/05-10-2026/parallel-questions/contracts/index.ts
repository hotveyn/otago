/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * Single source of truth for the data shape during planning. Hand-authored TypeScript; NOT a
 * runtime module and not generated. There is no codegen in this repo: the server implements
 * these shapes in `server/src/questions/*` and `server/src/storage/node-names.ts`, the web
 * mirrors them by hand in `web/src/api/types.ts`.
 *
 * Files:
 *  - shared.ts           existing shapes reused (NodeId, AttachmentEvent, UserFileInfo, …)
 *  - questions.ts        QuestionInfo / QuestionDetail / status / context / failure codes
 *  - questions-api.ts    HTTP routes: start (202), list, detail, DELETE (cancel|dismiss), retry;
 *                        removal of POST /messages; effects on structural routes
 *  - question-events.ts  GET /api/questions/events: SSE framing, events, ordering guarantees
 *  - errors.ts           new codes, 409 `tree_busy_streaming` details, status tables
 *  - lifecycle.ts        state machine, lock, retention, remap, held files, agent isolation,
 *                        shutdown (mostly server-internal)
 *  - naming.ts           naming after the answer (server-internal)
 *  - node-names.ts       Unicode node-name rules, NFC, URL transport
 *
 * Decisions (feature.md open questions and client requests):
 *  1. API shape: POST /api/trees/:tree/questions → 202 { question }; ONE app-wide SSE
 *     (/api/questions/events) with snapshot + deltas (`question`, `chunk`, `attachment`,
 *     `removed`); tree-less per-question routes /api/questions/:id; no polling, no per-question
 *     attach stream. POST /messages is removed in lockstep with the web.
 *  2. Replay: snapshot on every (re)connect + per-chunk `offset`/`attempt`; Last-Event-ID
 *     ignored in v1 (`id:` lines kept as a seam). `retry: 2000` and `: ping` every 15 s.
 *  3. Retention: cancelled → removed now; done → text dropped at commit, summary kept 30 min
 *     (cap 50/tree); failed → until dismissed/retried, 24 h TTL, cap 50/tree.
 *  4. Follow-up under a pending node: not allowed (parent must be an existing node).
 *  5. Unicode names: restricted Unicode slug (letters/marks/digits joined by `-`), NFKC→lower→
 *     NFC, 60 code points / 100 UTF-8 bytes, `nameKey` fold for collisions; tree ids stay
 *     ASCII; ids percent-encoded UTF-8 in query strings, normalized to NFC by the server.
 *  6. Naming: after the answer, question + cleaned answer excerpt (≤ 1500 chars), answer's
 *     language, 30 s timeout, fallback from the question.
 *  7. Uploads: validated and staged before registration; a rejected upload never creates an
 *     entry. Failed questions keep their files outside `trees/` for Retry.
 *  8. Client requests: live attachment state in snapshot/detail (`live.attachments`); file
 *     metadata for every status (`files`); `error: { message, code }`; server `instance` id;
 *     409 `details` on every exclusive route; full-object `question` events; retry's
 *     `question` precedes its chunks; `done` keeps parentId/context/nodeId/attachments/files.
 *  9. Risks: per-attempt watchdog (30 min → failed{timeout}); agent guard denies other
 *     answers' `.tmp-*` folders.
 */
export * from './errors';
export * from './lifecycle';
export * from './naming';
export * from './node-names';
export * from './question-events';
export * from './questions';
export * from './questions-api';
export * from './shared';
