/**
 * CONTRACT SPEC (planning artifact) — feature `rich-answers`. Owner: server.
 * Single source of truth for the data shapes during planning. There is no codegen in this
 * repo: `web/src/api/types.ts` is hand-maintained and must be updated to mirror these types
 * during /feature:implement.
 */
export * from './agent-tool';
export * from './attachments';
export * from './http';
export * from './sse';
