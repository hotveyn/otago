/**
 * CONTRACT SPEC (planning artifact) — feature `topic-split-v2`. Owner: server.
 * Single source of truth for the data shape during planning. Hand-authored TypeScript; NOT a
 * runtime module and not generated. There is no codegen in this repo: the server implements
 * these shapes (`server/src/storage/suggestion-block.ts`, `server/src/storage/suggestions.ts`,
 * `server/src/storage/node-suggestions.ts`, `server/src/agent/prompt.ts`), the web mirrors the
 * HTTP shape by hand in `web/src/api/types.ts`, the demo mock imports the pure server modules.
 *
 * BASE: the archived contract of `inline-suggestions`
 * (`.claude/features/archive/15-10-2026/inline-suggestions/contracts/`). Everything not stated
 * here as CHANGED / NEW stays as it was there (marker line, block grammar, streaming filter,
 * `suggestionKey`, sanitizer, owner validation of inherited items, "used" rule, candidates in
 * `<open-suggestions>`, single writer `createNode`, GET always `ready`, no lock, no cap).
 *
 * Files:
 *  - shared.ts           reused shapes (NodeId with `""` = tree root, question start body)
 *  - block.ts            NEW item prefix `<!-- otago:whole -->` for the "explain it whole" item;
 *                        filter and split UNCHANGED; pure helpers to parse / write the prefix
 *  - node-file.ts        stored item gains optional `kind: 'whole'` (stored with `up: 1`)
 *  - suggestions.ts      resolved `Suggestion` gains optional `kind`; target may be `""`;
 *                        resolution, targets, candidates and finalization rules for `whole`
 *  - suggestions-api.ts  GET shape (unchanged envelope) + client rules for the special button
 *  - agent.ts            server-internal: the new "Big topics" prompt section and its tests
 *
 * DECISIONS (feature.md open questions owned by the server):
 *  1. Block grammar: a PREFIX on an ordinary item line, `- <!-- otago:whole --> <text>`
 *     (./block.ts). It is still an ITEM line for the existing grammar, so the line machine, the
 *     streaming filter and `splitSuggestionBlock` are UNCHANGED and keep withholding the whole
 *     block (special item included) from chunks and `live.answer`. A second marker line was
 *     rejected: a standalone line inside the block would be a non-item line and break (reject)
 *     the block under today's grammar, so it would need a grammar change in both the filter
 *     and the split, and a misplaced one would leak the parts into the answer.
 *  4. "Whole" item without a split: DROPPED. It is kept only when the finalized list of the same
 *     block has at least TWO own regular items (`up: 0`, no `kind`) — the parts of the map
 *     (./suggestions.ts `MIN_SPLIT_PARTS`). A "whole" button on an answer that is not a map
 *     would re-ask the parent's question and only confuse.
 *  -  More than one "whole" item: the FIRST one that survives sanitizing / asked / dedupe is
 *     kept, the rest are dropped.
 * Other decisions:
 *  5. Stored form `{ text, up: 1, kind: 'whole' }`: `up: 1` keeps the meaning of `up` ("asked
 *     from the node `up` levels above") and makes an older reader drop the item safely (owner
 *     validation fails / `up > depth` for a top-level map), instead of showing it as an own
 *     button of the map node.
 *  6. Target of "whole" = the map node's parent, computed from the chain at read time (follows
 *     moves and renames). For a top-level map node the target is `""` (the tree root, the same
 *     `parentId` a first question of a tree uses). This is the ONLY case in which a resolved
 *     `Suggestion.target` is `""`.
 *  7. "Whole" is never inherited (skipped by the ancestor fallback), never a candidate in
 *     `<open-suggestions>`, never kept through a block, and never validated against an owner.
 *  8. Resolved order: own regular items, inherited items, then the "whole" item LAST (the
 *     stored order; finalization appends it). The web may still style it distinctly.
 *  9. No new route, error code, lock, config key, SSE event or frontmatter key; old nodes parse
 *     unchanged (no `kind` = regular item); nothing is migrated.
 */
export * from './agent';
export * from './block';
export * from './node-file';
export * from './shared';
export * from './suggestions';
export * from './suggestions-api';
