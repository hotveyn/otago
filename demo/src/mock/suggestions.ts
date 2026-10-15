/**
 * The demo's stand-in for the answering agent's suggestion block (contract
 * `.claude/features/inline-suggestions/contracts/agent.ts`, prompt section "Next questions"):
 * which item texts the model would write after its answer. `questions.ts` appends them with
 * `suggestionBlock`; the server's pure modules do the rest (filter, split, finalization).
 * Pure: no I/O, no timers, deterministic for a given `random`.
 */

import { collapseWhitespace, firstLine, truncateGraphemes } from '../../../server/src/text';

export interface SimulatedBlockInput {
  treeId: string;
  parentId: string;
  /** The question text as sent (`''` for a files-only message). */
  question: string;
  /** Texts of the parent's open suggestions, in order (the server's `<open-suggestions>`). */
  openSuggestions: readonly string[];
  attempt: number;
}

/** Item texts of the block to append; `undefined` = no block; `[]` = the marker line alone. */
export type BlockSimulator = (input: SimulatedBlockInput) => readonly string[] | undefined;

const PLAN_RE = /\b(plan|steps?|chapters?|roadmap|outline)\b/i;
/** Our own step texts: asking one continues the plan, it does not start a new one. */
const STEP_RE = /^Let's (?:start with|go to) (step \d+ of .+)$/;
const PLAN_REQUEST_RE =
  /^(?:please\s+)?(?:make|give|write|create|draft)(?:\s+me)?\s+(?:an?\s+)?(?:plan|roadmap|outline)\s+(?:for|of|on|about)\s+/i;
const TOPIC_MAX_WORDS = 6;
const TOPIC_MAX_GRAPHEMES = 60;
const OWN_TEMPLATES: ReadonlyArray<(topic: string) => string> = [
  (topic) => `Can you show a bigger example of ${topic}?`,
  (topic) => `What are common mistakes with ${topic}?`,
  (topic) => `Give me a short exercise on ${topic}`,
  (topic) => `How does ${topic} work under the hood?`,
];
/** Below this draw: no block (the common case; open suggestions stay visible by inheritance). */
const NO_BLOCK_BELOW = 0.4;
/** Below this draw: the marker line alone when there are open suggestions (drops them all). */
const EMPTY_BELOW = 0.5;
/** Chance to keep each open suggestion verbatim in a block with own items. */
const KEEP_PROBABILITY = 0.7;

/** What a question is about, for the template texts. */
export function suggestionTopic(question: string): string {
  const line = collapseWhitespace(firstLine(question));
  if (!line || line.startsWith('Attached files:')) return 'these files';
  const step = STEP_RE.exec(line)?.[1];
  const text = (step ?? line).replace(PLAN_REQUEST_RE, '').replace(/[?.!]+$/, '');
  const words = text.split(' ').slice(0, TOPIC_MAX_WORDS).join(' ');
  return truncateGraphemes(words, TOPIC_MAX_GRAPHEMES).trim() || 'this';
}

/**
 * The default block "model". A plan-like question gets "step 1 / 2 / 3" plus every open
 * suggestion; a step question keeps exactly the open suggestions (the remaining steps), or
 * writes no block without any. Otherwise often no block, sometimes the marker alone (drops the
 * open suggestions), else 1–2 template questions plus most open suggestions verbatim.
 */
export function simulateSuggestionBlock(random: () => number): BlockSimulator {
  return ({ question, openSuggestions }) => {
    const topic = suggestionTopic(question);
    if (STEP_RE.test(collapseWhitespace(firstLine(question)))) {
      return openSuggestions.length > 0 ? [...openSuggestions] : undefined;
    }
    if (PLAN_RE.test(question)) {
      return [
        `Let's start with step 1 of ${topic}`,
        `Let's go to step 2 of ${topic}`,
        `Let's go to step 3 of ${topic}`,
        ...openSuggestions,
      ];
    }
    const r = random();
    if (r < NO_BLOCK_BELOW) return undefined;
    if (r < EMPTY_BELOW) return openSuggestions.length > 0 ? [] : undefined;
    const count = 1 + Math.floor(random() * 2);
    const start = Math.floor(random() * OWN_TEMPLATES.length);
    const own: string[] = [];
    for (let i = 0; i < count; i++) {
      const template = OWN_TEMPLATES[(start + i) % OWN_TEMPLATES.length];
      if (template) own.push(template(topic));
    }
    const kept = openSuggestions.filter(() => random() < KEEP_PROBABILITY);
    return [...own, ...kept];
  };
}
