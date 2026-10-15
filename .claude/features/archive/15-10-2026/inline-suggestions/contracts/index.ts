/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 * Single source of truth for the data shape during planning. Hand-authored TypeScript; NOT a
 * runtime module and not generated. There is no codegen in this repo: the server implements
 * these shapes (`server/src/storage/suggestions.ts`, `server/src/storage/suggestion-block.ts`,
 * `server/src/storage/node-suggestions.ts`, `server/src/routes/suggestions.ts`,
 * `server/src/questions/runner.ts`, `server/src/agent/prompt.ts`), the web mirrors the HTTP
 * shapes by hand in `web/src/api/types.ts`, the demo mock imports the pure server modules.
 *
 * BASE: the archived contract of `suggested-prompts`
 * (`.claude/features/archive/15-10-2026/suggested-prompts/contracts/`). Everything not stated
 * here as CHANGED / REMOVED / NEW stays as it was there (storage format, `{ text, up }`, key
 * function, sanitizer, owner validation on read, "used" rule, no tree lock).
 *
 * Files:
 *  - shared.ts           existing shapes reused (NodeId, TreeId, ChainNode, question body)
 *  - node-file.ts        node.md storage (UNCHANGED format; states re-defined: absent = inherit)
 *  - block.ts            NEW: the marker block the answering agent appends; grammar, streaming
 *                        filter, split at save (pure, Node-free; server + demo identical)
 *  - suggestions.ts      resolved `Suggestion`; resolution on read (now with ancestor fallback,
 *                        no cap), candidates, finalization from block texts (no cap)
 *  - suggestions-api.ts  GET only (always `ready`); POST removed; client rules
 *  - errors.ts           `suggestions_failed` removed; status table of GET
 *  - agent.ts            server-internal: AskInput, prompt rules, `<open-suggestions>`, runner
 *                        lifecycle, config and CLI changes. Replaces the archived generation.ts.
 *
 * DECISIONS (feature.md open questions):
 *  1. Marker syntax (./block.ts): one line `<!-- otago:suggestions -->`, followed only by list
 *     item lines (`- text`) and blank lines up to the end of the answer. No closing marker.
 *     Detected line by line while streaming: only an incomplete line that could still become
 *     the marker is held back; from a marker line on everything is held until a line breaks
 *     the block (then it is released) or the stream ends (then it is the block). Marker lines
 *     inside fenced code blocks never count.
 *  2. Candidates reach the agent in the USER prompt (`buildUserPrompt`): an `<open-suggestions>`
 *     block between `</transcript>` and the new question, one `- <text>` per candidate, no
 *     numbers, no owner. The static rules live in SYSTEM_RULES. The agent keeps a candidate by
 *     copying its text verbatim into its block; the server maps a text equal (by
 *     `suggestionKey`) to a candidate back to that candidate's owner. Any other text is a new
 *     own item. Writing no block leaves the candidates visible through inheritance.
 *  3. GET keeps the response shape but `state` is always `'ready'`: the `missing` variant is
 *     removed. A node without a stored list resolves to the list of its nearest ancestor with
 *     one (E1); none → `[]`. The web drops its lazy POST and `missing` handling.
 *  4. `pnpm --filter @otago/server ask` streams the answer through the same filter the server
 *     uses (the block is never printed inline) and then prints the open suggestions it offered,
 *     the raw block items and the finalized items (or "none (no block)" / a rejected-marker
 *     warning). It still writes nothing.
 * Other decisions:
 *  5. No cap anywhere: MAX_SUGGESTIONS is removed from resolution, candidates and finalization
 *     (server, demo and web).
 *  6. Suggestions are written only by `createNode` at the commit (E12); the verified later
 *     write, adoption, dedup map and the `Suggestions` service are removed.
 *  7. Candidates are computed per attempt in the runner, before `agent.ask`, from the attempt's
 *     chain (read under the shared lock) plus a scan of the targets' live children.
 *  8. Logging: a warning only when a marker line was found but rejected (not a valid final
 *     block). An answer without a block is the normal case ("often none") and is not logged.
 *  9. An answer that is empty after removing the block fails the attempt like an empty answer
 *     (`agent_error`, 'Agent returned an empty answer').
 */
export * from './agent';
export * from './block';
export * from './errors';
export * from './node-file';
export * from './shared';
export * from './suggestions';
export * from './suggestions-api';
