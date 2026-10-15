/**
 * Suggested follow-up prompts, simulated: the mock of `server/src/suggestions/service.ts`.
 * The algorithms (candidates, finalization, resolution, the file format) come straight from
 * the server's pure module `server/src/storage/suggestions.ts`; only the model call is
 * simulated (`SuggestSimulator`). Contract: `.claude/features/suggested-prompts/contracts/`.
 *
 * - Lazy path (`ensure`, POST): one generation per (tree, node) at a time (in-memory dedup),
 *   then the verified write (`TreeStore.writeSuggestions`).
 * - At save (`forAnswer`, question runner): runs in parallel with naming; the runner peeks at
 *   commit, and adopts a generation that is still running (written later, joined by a POST).
 * - No tree lock anywhere: structural routes are never refused because of a generation.
 */

import {
  finalizeSuggestions,
  pickCandidates,
  type StoredSuggestion,
  type SuggestionCandidate,
  type SuggestPick,
  suggestionKey,
} from '../../../server/src/storage/suggestions';
import { collapseWhitespace, firstLine, truncateGraphemes } from '../../../server/src/text';
import { ApiError } from '../../../web/src/api/client';
import type { SuggestionsReady, SuggestionsResponse } from '../../../web/src/api/types';
import { nodeNotFound, suggestionsFailed } from './errors';
import type { Schedule } from './questions';
import type { SuggestionRecord, SuggestionSnapshot, TreeStore } from './trees';

export interface SimulatedSuggestInput {
  treeId: string;
  /** Undefined for the at-save case (node not committed yet). */
  nodeId?: string;
  /** Ancestors of the node, top-level first. */
  ancestors: Array<{ id: string; user: string; assistant: string }>;
  current: { user: string; assistant: string };
  candidates: SuggestionCandidate[];
  /** Aborted when the question is cancelled or fails before its commit. */
  signal: AbortSignal;
}

export interface SimulatedSuggestResult {
  /** Simulated model time. */
  delayMs: number;
  /** The "model reply"; a promise lets tests gate a generation by hand. */
  picks: SuggestPick[] | 'fail' | Promise<SuggestPick[] | 'fail'>;
}

export type SuggestSimulator = (input: SimulatedSuggestInput) => SimulatedSuggestResult;

/** A generation started at save time, handed to the question runner. */
export interface PendingSuggestions {
  /** Ready list, `null` after a failure, `undefined` while running. */
  peek(): StoredSuggestion[] | null | undefined;
  /** The node was committed without the list: write it there once the generation finishes. */
  adopt(treeId: string, nodeId: string, snapshot: SuggestionSnapshot): void;
  /** Cancel a generation that was not adopted. */
  abort(): void;
}

interface Generation {
  promise: Promise<StoredSuggestion[]>;
  abort(): void;
}

const keyOf = (treeId: string, nodeId: string) => `${treeId}\0${nodeId}`;

const aborted = () => new DOMException('Suggestion generation aborted', 'AbortError');

export class Suggestions {
  private readonly trees: TreeStore;
  private readonly schedule: Schedule;
  private readonly simulate: SuggestSimulator;
  /** Generation + verified write per (tree, node); removed once settled. */
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(options: { trees: TreeStore; schedule: Schedule; simulate: SuggestSimulator }) {
    this.trees = options.trees;
    this.schedule = options.schedule;
    this.simulate = options.simulate;
  }

  /** `GET /trees/:tree/suggestions?node=`. */
  view(treeId: string, nodeId: string): SuggestionsResponse {
    return this.trees.suggestionsView(treeId, nodeId);
  }

  /** `POST /trees/:tree/suggestions`: stored at once, else join or start the generation. */
  async ensure(treeId: string, nodeId: string): Promise<SuggestionsReady> {
    const current = this.view(treeId, nodeId);
    if (current.state === 'ready') return current;
    const key = keyOf(treeId, nodeId);
    const job = this.jobs.get(key) ?? this.startLazy(treeId, nodeId);
    await job;
    const after = this.view(treeId, nodeId);
    if (after.state !== 'ready') throw suggestionsFailed();
    return after;
  }

  /** At save: generate for the answer about to be committed under `parentId`. */
  forAnswer(input: {
    treeId: string;
    parentId: string;
    question: string;
    answer: string;
  }): PendingSuggestions {
    let generation: Generation;
    try {
      const ancestors = this.trees.suggestionChain(input.treeId, input.parentId);
      generation = this.generate(input.treeId, ancestors, {
        user: input.question,
        assistant: input.answer,
      });
    } catch {
      return { peek: () => null, adopt: () => undefined, abort: () => undefined };
    }
    let state: StoredSuggestion[] | null | undefined;
    generation.promise.then(
      (items) => {
        state = items;
      },
      () => {
        state = null;
      },
    );
    let adopted = false;
    return {
      peek: () => state,
      adopt: (treeId, nodeId, snapshot) => {
        if (adopted) return;
        adopted = true;
        // Any outcome but `written` is discarded silently; a joined POST sees the mapping.
        this.track(keyOf(treeId, nodeId), this.persist(generation, treeId, nodeId, snapshot));
      },
      abort: () => {
        if (!adopted) generation.abort();
      },
    };
  }

  /** Test aid: number of generations in flight (dedup map size). */
  inFlight(): number {
    return this.jobs.size;
  }

  private startLazy(treeId: string, nodeId: string): Promise<void> {
    const records = this.trees.suggestionChain(treeId, nodeId);
    const node = records.at(-1);
    if (!node) throw nodeNotFound(nodeId);
    const snapshot = { created: node.created, user: node.user, assistant: node.assistant };
    const generation = this.generate(
      treeId,
      records.slice(0, -1),
      { user: node.user, assistant: node.assistant },
      nodeId,
    );
    return this.track(keyOf(treeId, nodeId), this.persist(generation, treeId, nodeId, snapshot));
  }

  private track(key: string, job: Promise<void>): Promise<void> {
    this.jobs.set(key, job);
    const settle = () => {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    };
    job.then(settle, settle);
    return job;
  }

  /** Generation → verified write → outcome mapping (resolves, or rejects with an `ApiError`). */
  private persist(
    generation: Generation,
    treeId: string,
    nodeId: string,
    snapshot: SuggestionSnapshot,
  ): Promise<void> {
    return generation.promise.then(
      (items) => {
        let outcome: ReturnType<TreeStore['writeSuggestions']>;
        try {
          outcome = this.trees.writeSuggestions(treeId, nodeId, snapshot, items);
        } catch {
          // A full storage (413, rolled back): the node stays MISSING.
          throw suggestionsFailed();
        }
        if (outcome === 'changed') throw suggestionsFailed();
        if (outcome === 'gone') throw this.goneError(treeId, nodeId);
      },
      () => {
        throw suggestionsFailed();
      },
    );
  }

  /** The 404 the id gives now (`tree_not_found` after a tree rename, else `node_not_found`). */
  private goneError(treeId: string, nodeId: string): ApiError {
    try {
      this.trees.suggestionsView(treeId, nodeId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return error;
    }
    return nodeNotFound(nodeId);
  }

  /**
   * One simulated model call for a node whose ancestors are `ancestors` (top-level first).
   * Candidates are read now, while the caller guarantees the chain is current.
   */
  private generate(
    treeId: string,
    ancestors: SuggestionRecord[],
    current: { user: string; assistant: string },
    nodeId?: string,
  ): Generation {
    const askedKeys = new Set([
      ...ancestors.map((record) => suggestionKey(record.user)),
      suggestionKey(current.user),
    ]);
    const used = this.trees.usedKeys(
      treeId,
      ancestors.map((record) => record.id),
    );
    const candidates = pickCandidates(ancestors, used, askedKeys);
    const controller = new AbortController();
    const { signal } = controller;
    const promise = (async () => {
      const result = this.simulate({
        treeId,
        ...(nodeId !== undefined && { nodeId }),
        ancestors: ancestors.map(({ id, user, assistant }) => ({ id, user, assistant })),
        current,
        candidates,
        signal,
      });
      await this.wait(result.delayMs, signal);
      const picks = await untilAborted(Promise.resolve(result.picks), signal);
      if (picks === 'fail') throw new Error('Simulated suggestion failure');
      return finalizeSuggestions(picks, candidates, { depth: ancestors.length, askedKeys });
    })();
    // Failures are observed by whoever needs them; never an unhandled rejection.
    promise.catch(() => undefined);
    return { promise, abort: () => controller.abort() };
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(aborted());
        return;
      }
      const cancel = this.schedule(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        cancel();
        reject(aborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// --- Default simulator --------------------------------------------------------------------

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
const EMPTY_BELOW = 0.12;
const FAIL_BELOW = 0.2;
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
 * The demo's stand-in for the model. Plan-like questions get "step 1 / 2 / 3" suggestions and
 * keep every candidate (so a visitor sees inheritance after clicking step 1). Otherwise:
 * sometimes nothing (stored empty), sometimes a failure at save (the web's lazy POST then
 * generates on open; the lazy path never fails), else 1–3 template questions plus most
 * candidates. Deterministic for a given `random`.
 */
export function simulateSuggestions(random: () => number): SuggestSimulator {
  return (input) => {
    const lazy = input.nodeId !== undefined;
    const delayMs = lazy ? 600 + Math.floor(random() * 900) : 250 + Math.floor(random() * 750);
    const question = input.current.user;
    const topic = suggestionTopic(question);
    const keepAll = input.candidates.map((_, keep) => ({ keep }));
    if (PLAN_RE.test(question) && !STEP_RE.test(collapseWhitespace(firstLine(question)))) {
      const steps = [
        `Let's start with step 1 of ${topic}`,
        `Let's go to step 2 of ${topic}`,
        `Let's go to step 3 of ${topic}`,
      ];
      return { delayMs, picks: [...steps.map((text) => ({ text })), ...keepAll] };
    }
    const r = random();
    if (r < EMPTY_BELOW) return { delayMs, picks: [] };
    if (r < FAIL_BELOW && !lazy) return { delayMs, picks: 'fail' };
    const count = 1 + Math.floor(random() * 3);
    const start = Math.floor(random() * OWN_TEMPLATES.length);
    const own: SuggestPick[] = [];
    for (let i = 0; i < count; i++) {
      const template = OWN_TEMPLATES[(start + i) % OWN_TEMPLATES.length];
      if (template) own.push({ text: template(topic) });
    }
    const kept = keepAll.filter(() => random() < KEEP_PROBABILITY);
    return { delayMs, picks: [...own, ...kept] };
  };
}
