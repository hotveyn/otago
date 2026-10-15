// Suggested follow-up prompts: generation (at save and lazy), in-memory dedup per node and the
// verified write. Contract: .claude/features/suggested-prompts/contracts/generation.ts and
// suggestions-api.ts. Takes no tree lock anywhere.
import type { Agent, SuggestExchange } from '../agent/index.js';
import { InvalidInputError, NotFoundError, SuggestionsFailedError } from '../errors.js';
import { namingQuestion } from '../questions/title.js';
import { type QuestionLogger, silentLogger } from '../questions/types.js';
import {
  type ChainNode,
  existingTreeDir,
  finalizeSuggestions,
  nodeIdSegments,
  readCandidates,
  readChain,
  readSuggestionChain,
  readSuggestionsView,
  type StoredSuggestion,
  type SuggestionSnapshot,
  type SuggestionsReady,
  type SuggestionsResponse,
  storedSnapshot,
  suggestionKey,
  suggestionsViewOf,
  writeNodeSuggestions,
} from '../storage/index.js';

/** Per generation (at save and lazy). Then: failure → the list stays missing. */
export const SUGGEST_TIMEOUT_MS = 30_000;

export interface SuggestionTimings {
  /** Max duration of one model call. */
  timeoutMs: number;
}

export interface SuggestionsOptions {
  agent: Agent;
  treesDir: string;
  /** Model of every suggestion call (`ModelConfig.suggest`). */
  model: string;
  timings?: Partial<SuggestionTimings>;
  log?: QuestionLogger;
}

/** An at-save generation (see `Suggestions.forAnswer`). */
export interface PendingSuggestions {
  /** Settled value: the list on success, `null` on failure, `undefined` while running. */
  peek(): StoredSuggestion[] | null | undefined;
  /**
   * The node was committed without a list: key the generation under (tree, node) so a lazy
   * POST joins it, and store its result with the verified write once it is there.
   */
  adopt(tree: string, nodeId: string, snapshot: SuggestionSnapshot): void;
  /** Abort the generation (cancel / failure before the commit). No-op after `adopt`. */
  abort(): void;
}

export interface ForAnswerInput {
  treeDir: string;
  parentId: string;
  /** What the naming call sees as the question (`Attached files: …` for files only). */
  question: string;
  answer: string;
  /** The attempt's signal: aborting it aborts the generation until it is adopted. */
  signal: AbortSignal;
}

/** Exchange of a stored node for the prompt (a files-only question as naming sees it). */
function exchangeOf(node: ChainNode): SuggestExchange {
  return {
    id: node.id,
    user: namingQuestion(
      node.user,
      node.files.map((file) => file.name),
    ),
    assistant: node.assistant,
  };
}

function keyOf(tree: string, nodeId: string): string {
  return `${tree}\0${nodeId}`;
}

export class Suggestions {
  private readonly agent: Agent;
  private readonly treesDir: string;
  private readonly model: string;
  private readonly timings: SuggestionTimings;
  private readonly log: QuestionLogger;
  /** Running generation (+ write) per (tree, node): at most one per node. */
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<unknown>>();
  /** Bumped whenever a registered generation settles (after its write). */
  private epoch = 0;
  private closed = false;

  constructor(options: SuggestionsOptions) {
    this.agent = options.agent;
    this.treesDir = options.treesDir;
    this.model = options.model;
    this.timings = { timeoutMs: SUGGEST_TIMEOUT_MS, ...options.timings };
    this.log = options.log ?? silentLogger;
  }

  /** `GET`: pure read of a node's resolved suggestions. */
  async view(tree: string, nodeId: string): Promise<SuggestionsResponse> {
    const treeDir = await this.nodeTreeDir(tree, nodeId);
    return readSuggestionsView(treeDir, nodeId);
  }

  /**
   * `POST`: the stored list, or the result of the node's generation (joined when one runs,
   * started otherwise). 404 when the node is gone (also when it moved meanwhile), 502
   * `suggestions_failed` when the generation failed or the file changed.
   */
  async ensure(tree: string, nodeId: string): Promise<SuggestionsReady> {
    const treeDir = await this.nodeTreeDir(tree, nodeId);
    const key = keyOf(tree, nodeId);
    for (;;) {
      const running = this.inflight.get(key);
      if (running) {
        await this.join(tree, running);
        break;
      }
      const epoch = this.epoch;
      const chain = await readSuggestionChain(treeDir, nodeId);
      const current = await suggestionsViewOf(treeDir, nodeId, chain);
      if (current.state === 'ready') return current;
      if (this.closed) throw new SuggestionsFailedError();
      // A generation started, or one finished (its write may postdate our read): look again.
      if (this.inflight.has(key) || this.epoch !== epoch) continue;
      await this.join(tree, this.startLazy(key, treeDir, nodeId, chain));
      break;
    }
    const view = await readSuggestionsView(treeDir, nodeId);
    if (view.state !== 'ready') throw new SuggestionsFailedError();
    return view;
  }

  private async join(tree: string, generation: Promise<void>): Promise<void> {
    try {
      await generation;
    } catch (error) {
      // A renamed tree is reported as such.
      if (error instanceof NotFoundError) await existingTreeDir(this.treesDir, tree);
      throw error;
    }
  }

  /**
   * Question runner, right after the answer: start a generation for the node about to be
   * committed under `parentId` (its chain is re-read for fresh ancestor lists). Never throws;
   * failures settle as `null`.
   */
  forAnswer(input: ForAnswerInput): PendingSuggestions {
    const controller = new AbortController();
    const onAttemptAbort = () => controller.abort();
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onAttemptAbort, { once: true });
    const unlink = () => input.signal.removeEventListener('abort', onAttemptAbort);
    this.controllers.add(controller);

    let settled: StoredSuggestion[] | null | undefined;
    let adopted = false;
    const generation = this.track(
      (async () => {
        if (this.closed) throw new Error('Suggestions are closed');
        const ancestors = await readChain(input.treeDir, input.parentId);
        return this.generate(
          input.treeDir,
          ancestors,
          { user: input.question, assistant: input.answer },
          [],
          controller.signal,
        );
      })().then(
        (items) => {
          settled = items;
          return items;
        },
        (error: unknown) => {
          settled = null;
          if (!controller.signal.aborted) {
            this.log.warn(error, `Suggestions failed for a new node under "${input.parentId}"`);
          }
          return null;
        },
      ),
    );
    void generation.finally(() => {
      if (adopted) return;
      this.controllers.delete(controller);
      unlink();
    });

    return {
      peek: () => settled,
      abort: () => {
        if (!adopted) controller.abort();
      },
      adopt: (tree, nodeId, snapshot) => {
        if (adopted) return;
        adopted = true;
        unlink();
        if (settled === null) {
          this.controllers.delete(controller);
          return;
        }
        const expected = storedSnapshot(snapshot);
        const task = (async () => {
          const items = await generation;
          if (items === null) throw new SuggestionsFailedError();
          await this.persist(input.treeDir, nodeId, expected, items, controller);
        })();
        const key = keyOf(tree, nodeId);
        // A lazy POST that started in between keeps its entry; the first write wins.
        this.register(this.inflight.has(key) ? undefined : key, controller, task);
      },
    };
  }

  /** Settles once no generation (or write) is running. Test seam. */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  /** Abort every running generation and wait for them; nothing is written afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.tasks]);
  }

  private async nodeTreeDir(tree: string, nodeId: string): Promise<string> {
    const treeDir = await existingTreeDir(this.treesDir, tree);
    if (nodeId === '') throw new InvalidInputError('The tree root has no suggestions');
    nodeIdSegments(nodeId);
    return treeDir;
  }

  private startLazy(
    key: string,
    treeDir: string,
    nodeId: string,
    chain: ChainNode[],
  ): Promise<void> {
    const controller = new AbortController();
    const node = chain.at(-1);
    if (!node) return Promise.reject(new SuggestionsFailedError());
    const snapshot: SuggestionSnapshot = {
      created: node.created,
      user: node.user,
      assistant: node.assistant,
    };
    const task = (async () => {
      let items: StoredSuggestion[];
      try {
        items = await this.generate(
          treeDir,
          chain.slice(0, -1),
          exchangeOf(node),
          [node.user],
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          this.log.warn(error, `Suggestions failed for node "${nodeId}"`);
        }
        throw new SuggestionsFailedError();
      }
      await this.persist(treeDir, nodeId, snapshot, items, controller);
    })();
    this.controllers.add(controller);
    return this.register(key, controller, task);
  }

  /** Candidates, the model call (with the timeout) and finalization. */
  private async generate(
    treeDir: string,
    ancestors: ChainNode[],
    current: SuggestExchange,
    extraAskedTexts: string[],
    signal: AbortSignal,
  ): Promise<StoredSuggestion[]> {
    const askedKeys = new Set(
      [...ancestors.map((node) => node.user), current.user, ...extraAskedTexts].map(suggestionKey),
    );
    const candidates = await readCandidates(treeDir, ancestors, askedKeys);
    signal.throwIfAborted();
    const picks = await this.agent.suggest({
      ancestors: ancestors.map(exchangeOf),
      current,
      candidates,
      model: this.model,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timings.timeoutMs)]),
    });
    signal.throwIfAborted();
    return finalizeSuggestions(picks, candidates, { depth: ancestors.length, askedKeys });
  }

  /** Verified write; `gone` → 404 `node_not_found`, `changed` (or any error) → 502. */
  private async persist(
    treeDir: string,
    nodeId: string,
    snapshot: SuggestionSnapshot,
    items: StoredSuggestion[],
    controller: AbortController,
  ): Promise<void> {
    if (this.closed || controller.signal.aborted) throw new SuggestionsFailedError();
    let outcome: Awaited<ReturnType<typeof writeNodeSuggestions>>;
    try {
      outcome = await writeNodeSuggestions(treeDir, nodeId, snapshot, items, {
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.log.warn(error, `Could not store the suggestions of node "${nodeId}"`);
      }
      throw new SuggestionsFailedError();
    }
    if (outcome === 'gone') throw new NotFoundError(`Node not found: ${nodeId}`, 'node_not_found');
    if (outcome === 'changed') throw new SuggestionsFailedError();
  }

  /** Track a generation; with a `key`, joinable until it settles (success or failure). */
  private register(
    key: string | undefined,
    controller: AbortController,
    task: Promise<void>,
  ): Promise<void> {
    this.controllers.add(controller);
    const entry: Promise<void> = task.finally(() => {
      this.epoch++;
      this.controllers.delete(controller);
      if (key !== undefined && this.inflight.get(key) === entry) this.inflight.delete(key);
    });
    // Nobody may be waiting (adopted at-save generations): never an unhandled rejection.
    entry.catch(() => undefined);
    if (key !== undefined) this.inflight.set(key, entry);
    this.track(entry);
    return entry;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.catch(() => undefined);
    this.tasks.add(tracked);
    void tracked.finally(() => this.tasks.delete(tracked));
    return promise;
  }
}
