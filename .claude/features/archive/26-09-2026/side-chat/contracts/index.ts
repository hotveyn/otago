/**
 * CONTRACT SPEC index — feature `side-chat`. Owner: server. Planning artifact only.
 *
 * - messages.ts     POST /trees/:tree/messages request + SSE events (wire format unchanged)
 * - concurrency.ts  per-tree readers–writer lock semantics, 409 matrix, move/delete shapes
 * - errors.ts       JSON error body; new optional `code` on 409
 *
 * No new endpoints. No generated API types exist in this repo (no OpenAPI codegen);
 * the web client mirrors these shapes by hand in its own API layer.
 */
export * from './concurrency';
export * from './errors';
export * from './messages';
