/**
 * CONTRACT SPEC (planning artifact) — feature `suggested-prompts`. Owner: server.
 * Single source of truth for the data shape during planning. Hand-authored TypeScript; NOT a
 * runtime module and not generated. There is no codegen in this repo: the server implements
 * these shapes (`server/src/storage/suggestions.ts`, `suggestions/`, `routes/suggestions.ts`),
 * the web mirrors them by hand in `web/src/api/types.ts`, the demo mock mirrors the server.
 *
 * Files:
 *  - shared.ts           existing shapes reused (NodeId, TreeId, ChainNode, question body)
 *  - node-file.ts        node.md storage: `suggestions:` frontmatter line, missing vs empty,
 *                        write form, splice rules
 *  - suggestions.ts      resolved `Suggestion`, limits, key/sanitize, resolution and
 *                        finalization algorithms (server + demo identical)
 *  - suggestions-api.ts  GET / POST /api/trees/:tree/suggestions + client rules (fetch,
 *                        visibility, click, side-panel caveat)
 *  - errors.ts           new code `suggestions_failed` (502), status tables
 *  - generation.ts       server-internal: model/env, Agent.suggest, candidates, prompt,
 *                        parsing, timing (parallel with naming), lazy dedup, verified write
 *
 * Decisions (feature.md open questions):
 *  1. Cap: at most 5 stored per node, own first then inherited; the model is asked for ≤ 5
 *     total, the server enforces the order and the cap.
 *  2. Model: new `OTAGO_SUGGEST_MODEL`, defaulting to the naming default.
 *  3. Endpoint: separate resource. `GET …/suggestions?node=` → `{ state: 'ready' | 'missing' }`
 *     (pure read, resolved, "used" filtered); `POST …/suggestions {node}` → lazy generation,
 *     deduped per node, idempotent, no lock. The chain payload and SSE are unchanged.
 * Other decisions:
 *  4. Storage: one frontmatter line `suggestions: <JSON array of {text, up}>`; `up` = levels
 *     above the node (0 = own), inherited items always point at the ORIGINAL owner, validated
 *     on read against that owner's own list (moves drop them silently).
 *  5. At save, generation runs in parallel with naming and never delays the commit; a
 *     generation that is still running is adopted and written after the commit.
 */
export * from './errors';
export * from './generation';
export * from './node-file';
export * from './shared';
export * from './suggestions';
export * from './suggestions-api';
