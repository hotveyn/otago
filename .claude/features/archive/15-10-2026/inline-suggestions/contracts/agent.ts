/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 * Server-internal: how suggestions come out of the answering agent, how the runner handles
 * them, and what is removed. Replaces the archived `generation.ts` (separate generator).
 * Clients never see this; the demo mock simulates the observable behavior (its simulated answer
 * may end with a block, streamed through the same filter, finalized at commit).
 */
import type { SplitAnswer } from './block';
import type { StoredSuggestion } from './node-file';
import type { SuggestionCandidate } from './suggestions';

// ---------------------------------------------------------------------------
// REMOVED (server)
// ---------------------------------------------------------------------------

/**
 *  - `Agent.suggest`, `SuggestInput`, `SuggestExchange`, `SuggestPick` (agent/types.ts) and the
 *    SDK call in `claude-agent.ts`.
 *  - `SUGGEST_SYSTEM_PROMPT`, `SUGGEST_PROMPT`, `SUGGEST_ANCESTOR_LEVELS`,
 *    `SUGGEST_QUESTION_MAX_GRAPHEMES`, `SUGGEST_CURRENT_ANSWER`, `SUGGEST_ANCESTOR_ANSWER`,
 *    `headTailExcerpt`, `buildSuggestPrompt`, `parseSuggestReply` (agent/prompt.ts).
 *    `proseExcerpt` / `namingExcerpt` stay (naming).
 *  - `server/src/suggestions/` (the `Suggestions` service: lazy POST, at-save generation,
 *    adoption, dedup, verified write, `SUGGEST_TIMEOUT_MS`) — deleted.
 *  - `writeNodeSuggestions`, `SuggestionSnapshot`, `storedSnapshot`, `WriteSuggestionsOutcome`
 *    (storage/node-suggestions.ts).
 *  - `ModelConfig.suggest`, `OTAGO_SUGGEST_MODEL` (config.ts). A leftover variable in
 *    `server/.env` is ignored (E11); it is no longer added to `available`.
 *  - `AppDeps.suggestions`, `RouteDeps.suggestions`, `QuestionsOptions.suggestions`,
 *    `RunnerDeps.suggestions`.
 *  - The `oneShotOptions` SDK option set stays (naming only; thinking disabled).
 */
export type Removed = never;

// ---------------------------------------------------------------------------
// Agent interface (server `agent/types.ts`) — CHANGED
// ---------------------------------------------------------------------------

/** `AskInput` gains one REQUIRED field (everything else unchanged). */
export interface AskInputAddition {
  /**
   * Texts of the parent's still-open suggestions (`pickCandidates(...).map(c => c.text)`), in
   * resolution order; `[]` when none. Rendered into the user prompt; the agent keeps one by
   * copying its text.
   */
  openSuggestions: string[];
}

/**
 * `Agent.ask` is otherwise UNCHANGED: it streams the model's raw text (block included) and its
 * `done.text` is the full trimmed raw answer. The agent layer does NOT strip or parse the block;
 * the runner does (so `fakeAgent` scripts blocks as plain chunks).
 * `Agent` = `{ ask, name }` (no `suggest`).
 */
export type AgentShape = never;

// ---------------------------------------------------------------------------
// Prompt (`agent/prompt.ts`) — wording is the implementer's, semantics fixed
// ---------------------------------------------------------------------------

/**
 * SYSTEM_RULES gains a section (static, so it sits before the tree instructions and is the
 * same for every question of a tree). Requirements:
 *  - when the conversation sets up an obvious next step (the next chapter, the second part of a
 *    long chapter, a topic the answer itself says comes next), end the answer with the block;
 *  - only the most obvious next steps; often there is none — then no block;
 *  - NO number of questions anywhere (no "up to N", no "1-3");
 *  - each line one short, complete question or request as the learner would send it, in the
 *    language and script of the answer, not translated or transliterated; not the tutor's own
 *    check-your-understanding question; not a question already asked;
 *  - the block is the very last part of the answer, after the footnotes; nothing follows it;
 *    never mention or refer to it in the answer (the learner sees buttons, not text);
 *  - `<open-suggestions>`: a block replaces them — copy, word for word, each one still worth
 *    asking from here; no block = they stay as they are; the marker line alone = drop them all.
 * The last sentence "Answer only with the final answer text in Markdown." becomes "… in
 * Markdown, optionally followed by the next-questions block."
 *
 * Draft (to be adapted by the implementer):
 *
 *   Next questions:
 *   - If the conversation sets up an obvious next step, such as the next chapter, the second
 *     part of a long chapter, or a topic your answer says comes next, end the answer with the
 *     questions the learner would most likely send next, in this exact form:
 *     <!-- otago:suggestions -->
 *     - <question>
 *   - Only the most obvious next steps. Often there is none: then write no block.
 *   - Each line is one short, complete question or request worded as the learner would send
 *     it, in the language and script of your answer (do not translate or transliterate). Never
 *     your own check-your-understanding question, never a question already asked.
 *   - The block is the very last part of the answer, after the footnotes; nothing follows it.
 *     Never mention it: the learner sees these questions as buttons, not as text.
 *   - Earlier suggestions that are still open are listed in <open-suggestions> before the new
 *     question. A block replaces them: copy each one that is still a sensible next step from
 *     here into your block, word for word. Without a block they stay as they are. To drop them
 *     all, end the answer with the marker line alone.
 *
 * The marker string in the prompt must be `SUGGESTIONS_MARKER` (interpolated, not retyped).
 */
export type SystemRulesSection = never;

/**
 * `buildUserPrompt(chain, question, files = [], openSuggestions = [])` — CHANGED (decision for
 * open question 2): when `openSuggestions` is non-empty (only possible with a non-empty chain),
 * a block goes right after `</transcript>`:
 *
 *   <transcript>
 *   …
 *   </transcript>
 *   <open-suggestions>
 *   - Перейти к главе 4
 *   - Разбери вторую часть главы 3
 *   </open-suggestions>
 *
 *   Continue the conversation above. New question:
 *   <files>…</files>            (unchanged, when the message has files)
 *   <question>
 *
 * Texts are single-line (sanitized at save) and rendered as `- ${text}`; no numbers, no owner
 * label (the agent copies the text, the server re-derives the owner). Empty list → the output is
 * byte-identical to today's prompt.
 */
export type UserPromptBlock = never;

// ---------------------------------------------------------------------------
// Runner (`questions/runner.ts` `runAttempt`) — lifecycle per attempt
// ---------------------------------------------------------------------------

/**
 *  1. Before `agent.ask` (shared lock held, chain = the attempt's chain read under it):
 *       askedKeys  = { suggestionKey(n.user) for n in chain } ∪ { suggestionKey(job.text) }
 *       candidates = await readCandidates(treeDir, chain, askedKeys)
 *     A failure here is logged (`warn`) and treated as `[]`; it never fails the question.
 *     Then `throwIfAborted`.
 *  2. `agent.ask({ …, openSuggestions: candidates.map(c => c.text) })`.
 *  3. Every `chunk` → `registry.appendChunk(id, attempt, filter.push(text))` with one
 *     `SuggestionBlockFilter` per attempt (E7). On abort the loop breaks; nothing is flushed.
 *  4. After `done` (and the abort check): `registry.appendChunk(id, attempt, filter.end())`
 *     BEFORE the seal / `setNaming` (the flushed text belongs to the streaming phase).
 *  5. `split = splitSuggestionBlock(done.text)`; `split.rejected` → `log.warn(…)`.
 *     `split.answer.trim() === ''` → throw `Error('Agent returned an empty answer')`
 *     (agent_error, files held for retry as for any agent failure).
 *  6. `suggestions = split.items === undefined ? undefined
 *        : finalizeSuggestions(split.items, candidates, { depth: chain.length, askedKeys })`.
 *  7. Naming gets `split.answer` (never the block).
 *  8. Commit: `createNode(…, { created, model, user: job.text, assistant: split.answer,
 *     ...(suggestions ? { suggestions } : {}) })`. No adoption, no later write.
 *  9. Cancel / failure / timeout at any point before the commit: nothing stored (E6). A retry is
 *     a new attempt: fresh chain (prepareRetry), fresh candidates, fresh filter, its own block.
 */
export type RunnerLifecycle = never;

/** Server-internal values the runner holds between steps 1 and 8 (documentation aid). */
export interface AttemptSuggestionState {
  askedKeys: ReadonlySet<string>;
  candidates: SuggestionCandidate[];
  split: SplitAnswer;
  stored: StoredSuggestion[] | undefined;
}

// ---------------------------------------------------------------------------
// CLI `pnpm --filter @otago/server ask <tree> "<question>" [parentNodeId]` (open question 4)
// ---------------------------------------------------------------------------

/**
 * Writes nothing (unchanged). Computes candidates like the runner (read-only scan), passes
 * `openSuggestions`, streams stdout through a `SuggestionBlockFilter` (what the UI would show),
 * then prints, after the existing `--- done (…)` line:
 *   --- open suggestions offered: ["…", …]          (only when non-empty)
 *   --- node name: <name>                            (naming from the stripped answer)
 *   --- suggestions block: ["raw item", …]           (or: `--- suggestions: none (no block)`)
 *   --- suggestions stored: [{"text":"…","up":0},…]  (finalized; omitted when no block)
 *   --- warning: suggestions marker kept in the answer (not a valid final block)  (rejected)
 *   --- attachments: …                               (unchanged)
 * No `agent.suggest` call, no `models.suggest`.
 */
export type AskCli = never;
