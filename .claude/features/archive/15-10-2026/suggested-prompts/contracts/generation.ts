/**
 * CONTRACT SPEC (planning artifact) — feature `suggested-prompts`. Owner: server.
 * Server-internal: how suggestions are generated, when, by which model, and how they are
 * written. Clients never see this; the demo mock simulates the observable behavior only
 * (timing: a node may be saved first and get its list moments later; lazy POST; dedup).
 */
import type { StoredSuggestion } from './node-file';
import type { SuggestionCandidate, SuggestPick } from './suggestions';

// ---------------------------------------------------------------------------
// Model / config
// ---------------------------------------------------------------------------

/**
 * DECISION (feature open question 2): new env var `OTAGO_SUGGEST_MODEL`, default = the
 * resolved naming default (`OTAGO_NAMING_MODEL` or `claude-haiku-4-5`). Added to
 * `ModelConfig` as `suggest` and to `available` (like the other defaults). Not selectable per
 * request; `GET /api/models` is UNCHANGED (no `defaults.suggest`; nobody needs it).
 */
export const SUGGEST_MODEL_ENV = 'OTAGO_SUGGEST_MODEL';

// ---------------------------------------------------------------------------
// Agent interface (server `agent/types.ts`)
// ---------------------------------------------------------------------------

/** One exchange in the prompt. */
export interface SuggestExchange {
  /** Node id; `undefined` for a node not committed yet (the at-save case). */
  id?: string;
  /** User text; for a files-only message `Attached files: <names>` (as naming). */
  user: string;
  assistant: string;
}

/** `Agent.suggest` input. NEW. */
export interface SuggestInput {
  /** Ancestors of the node, top-level first (may be `[]` for a top-level node). */
  ancestors: SuggestExchange[];
  /** The node the suggestions are for (its question and full answer). */
  current: SuggestExchange;
  /** Inheritance candidates (see `pickCandidates`); `[]` when none. */
  candidates: SuggestionCandidate[];
  model: string;
  /** Aborted on cancel/shutdown and after SUGGEST_TIMEOUT_MS. */
  signal: AbortSignal;
}

/**
 * `Agent` gains, next to `name`:
 *   suggest(input: SuggestInput): Promise<SuggestPick[]>
 * Resolves with the parsed picks (possibly `[]`); THROWS on SDK failure, abort or an
 * unparseable reply. Sanitizing / mapping / capping is NOT the agent's job (finalizeSuggestions
 * in ./suggestions.ts runs in the service, so fake agents in tests return raw picks).
 */
export type AgentSuggest = (input: SuggestInput) => Promise<SuggestPick[]>;

// ---------------------------------------------------------------------------
// Candidates (inheritance input)
// ---------------------------------------------------------------------------

/**
 * `pickCandidates(chain, usedKeysByTarget)` for a node N whose ancestors are `chain`
 * (top-level first):
 *   - A = the NEAREST ancestor whose list is STORED (missing ancestors are skipped;
 *     "inheritance just skips it"). None → `[]`.
 *   - candidates = `resolveSuggestions(chain up to A, used)` of A (own + still-valid inherited,
 *     minus used), each mapped to `{ text, source: target, origin: index of target in chain }`.
 *   - minus items whose key equals the `user` of any chain node or of N itself.
 * A stored EMPTY list at the parent therefore stops inheritance (its generation decided
 * nothing carries over). Lazy generation never generates for ancestors.
 * Size ≤ MAX_SUGGESTIONS by construction.
 */
export type PickCandidates = never;

// ---------------------------------------------------------------------------
// Prompt (wording is the implementer's; semantics fixed) — `agent/prompt.ts`
// ---------------------------------------------------------------------------

/** Ancestors included in the prompt: the nearest N (older ones are omitted). */
export const SUGGEST_ANCESTOR_LEVELS = 4;
/** Per-question cut, graphemes. */
export const SUGGEST_QUESTION_MAX_GRAPHEMES = 500;
/**
 * Answer excerpts: the naming cleaning (`namingExcerpt` steps 1-4, refactored into a shared
 * `proseExcerpt(answer, max)`), then if longer than the cap keep HEAD + ` … ` + TAIL, both cut
 * at word/grapheme boundaries (plans and "next we can cover X" sit at the end of answers).
 */
export const SUGGEST_CURRENT_ANSWER = { head: 2_000, tail: 4_000 } as const;
export const SUGGEST_ANCESTOR_ANSWER = { head: 500, tail: 1_000 } as const;

/**
 *   system: You suggest a learner's next questions in a tutoring chat. Output only JSON.
 *   user:
 *     Suggest the learner's obvious next questions after the latest answer.
 *     - Only continuations the conversation itself sets up: a plan or list of topics stated
 *       in an answer ("chapter 1 first, then 2 and 3", "next we can cover X"), or a next step
 *       the latest answer explicitly offers. If nothing is obvious, return an empty list.
 *     - Each suggestion is a complete, short question or request (≤ 15 words) the learner
 *       would send, in the language and script of the latest answer's prose.
 *     - Do not answer the tutor's check-your-understanding questions; do not repeat questions
 *       already asked in the transcript.
 *     - Earlier suggestions (numbered below) were offered at earlier steps. Keep one by
 *       number only if it is still a sensible next step from here; never rewrite it.
 *     - At most 5 items in total, new ones first.
 *     Reply with JSON only: {"suggestions":[{"text":"…"},{"keep":2}]}
 *
 *     <transcript>   (ancestors, oldest first; omitted when none)
 *     <user>…</user> <assistant>…excerpt…</assistant> …
 *     </transcript>
 *     <latest>
 *     <user>…</user> <assistant>…excerpt…</assistant>
 *     </latest>
 *     <earlier-suggestions>   (omitted when no candidates)
 *     1. <text> (offered at: <source display name>)
 *     …
 *     </earlier-suggestions>
 *
 * Numbers in the prompt are 1-based; `parseSuggestReply` converts `keep` to the 0-based
 * `SuggestPick.keep`.
 * SDK call: like naming — isolated base options, `tools: []`, `maxTurns: 1`, no cwd/MCP.
 */
export type SuggestPrompt = never;

/**
 * `parseSuggestReply(raw, candidateCount): SuggestPick[]`:
 *   - strip a ```json / ``` fence if present; take the substring from the first `{` or `[`
 *     to the matching last `}` / `]`; `JSON.parse`.
 *   - accepted roots: `{ suggestions: [...] }` or a bare array. Anything else → THROW.
 *   - items: `{ text: string }` → `{ text }`; `{ keep: n }` with integer 1 ≤ n ≤ candidateCount
 *     → `{ keep: n - 1 }`; a bare string item → `{ text }`; everything else dropped.
 * Prompt injection through answers can at worst produce odd suggestion texts (sanitized,
 * capped, single line, never executed).
 */
export type ParseSuggestReply = (raw: string, candidateCount: number) => SuggestPick[];

// ---------------------------------------------------------------------------
// Timing and lifecycle
// ---------------------------------------------------------------------------

/** Per generation (both at-save and lazy). Then: failure → MISSING. */
export const SUGGEST_TIMEOUT_MS = 30_000;

/**
 * AT SAVE (question runner, `questions/runner.ts`), while the question is `naming`
 * (tree's shared lock still held, so the chain cannot move):
 *   1. Start the generation IN PARALLEL with `agent.name` (chain re-read from disk for fresh
 *      ancestor lists; current = { user: namingQuestion, assistant: final answer }).
 *   2. Naming finishes → commit point. The commit NEVER waits for suggestions:
 *        - generation already succeeded → node.md is created WITH the list;
 *        - already failed → created WITHOUT (missing);
 *        - still running → created WITHOUT; the generation is ADOPTED by the suggestion
 *          service under (tree, nodeId) and written later via the verified write below.
 *          A lazy POST for that node joins it (no second model call).
 *   3. Cancel (DELETE) before the commit / shutdown → the generation is aborted. A
 *      generation failure never fails the question; no new question status, no SSE change.
 *
 * LAZY (POST, ./suggestions-api.ts): chain read at start (N last), candidates from N's
 * ancestors, generation, verified write. In-memory dedup map keyed by (tree id, node id),
 * entry removed when the generation settles (success or failure → next open may retry).
 *
 * VERIFIED WRITE (both "later" paths): re-read `node.md` at the node's id; write only if
 *   (a) the tree and node still resolve, (b) `created`, `user` and `assistant` equal the
 *   snapshot the generation started from, (c) the list is still MISSING. Then splice the line
 *   (./node-file.ts rule 3) and `writeFileAtomic` in the node folder. (a)/(b) fail → discard;
 *   (c) fails → discard ours, the stored one wins. ENOENT during the write (moved/deleted in
 *   between) → discard. Never creates directories. No tree lock is taken.
 *
 * SHUTDOWN: the suggestion service aborts every running generation on app close (nothing
 * written afterwards).
 */
export type Lifecycle = never;

/** Server-internal shape returned by the lazy path before resolution. */
export type GenerationResult = StoredSuggestion[];
