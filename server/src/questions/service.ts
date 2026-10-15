import type { Agent, TreeLocks } from '../agent/index.js';
import { AppError, ConflictError, NotFoundError } from '../errors.js';
import {
  type AnswerStaging,
  type ChainNode,
  createAnswerStaging,
  createHeldFiles,
  existingTreeDir,
  type HeldFiles,
  nodeDirOf,
  type PromptFile,
  readChain,
  readTree,
  stagedPromptFiles,
  sweepStaleStaging,
  type UserFileInfo,
} from '../storage/index.js';
import { QuestionRegistry, type SubscribeOptions, type Subscription } from './registry.js';
import { type QuestionJob, type RunnerDeps, runAttempt } from './runner.js';
import { agentQuestion, namingQuestion, questionTitle } from './title.js';
import {
  DEFAULT_QUESTION_TIMINGS,
  type QuestionContext,
  type QuestionDetail,
  type QuestionHooks,
  type QuestionInfo,
  type QuestionLogger,
  type QuestionTimings,
  type RunningQuestion,
  silentLogger,
  type TreeBusyDetails,
} from './types.js';

export interface QuestionsOptions {
  agent: Agent;
  /** Must be the app's lock instance. */
  locks: TreeLocks;
  treesDir: string;
  allowPrivateUrls?: boolean;
  /** Holding folder for files of failed questions. Default: an owned folder in the OS temp dir. */
  heldDir?: string;
  timings?: Partial<QuestionTimings>;
  log?: QuestionLogger;
  hooks?: QuestionHooks;
}

/** What `POST /trees/:tree/questions` prepared before registering the question. */
export interface StartQuestionInput {
  id: string;
  tree: string;
  treeDir: string;
  parentId: string;
  context: QuestionContext;
  /** Trimmed user text (`""` for a files-only message). */
  text: string;
  model: string;
  namingModel: string;
  instructions: string;
  chain: ChainNode[];
  /** Staging folder with the user's files already in `files/`. */
  staging: AnswerStaging;
  /** Staged user files (final names). */
  files: UserFileInfo[];
  promptFiles: PromptFile[];
  /** Also the staging's signal; aborted with an `AbortReason`. */
  controller: AbortController;
  /** Releases the shared lock taken with the question id as holder. */
  release: () => void;
}

interface Preparation {
  controller: AbortController;
  done: Promise<void>;
}

export function questionNotFound(id: string): NotFoundError {
  return new NotFoundError(`Question not found: ${id}`, 'question_not_found');
}

/** 404 `parent_not_found` for a parent chain that cannot be read. */
export function parentNotFound(parentId: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof NotFoundError) {
      throw new NotFoundError(`Parent node not found: ${parentId}`, 'parent_not_found');
    }
    throw error;
  };
}

/**
 * In-flight questions: the only thing routes talk to. Owns the registry, the running jobs,
 * retry preparation, held files and the shared locks of retries.
 */
export class Questions {
  readonly registry: QuestionRegistry;
  readonly timings: QuestionTimings;
  private readonly agent: Agent;
  private readonly locks: TreeLocks;
  private readonly treesDir: string;
  private readonly allowPrivateUrls: boolean;
  private readonly held: HeldFiles;
  private readonly log: QuestionLogger;
  private readonly hooks: QuestionHooks;
  private readonly jobs = new Map<string, QuestionJob>();
  private readonly preparing = new Map<string, Preparation>();
  private closed = false;

  constructor(options: QuestionsOptions) {
    this.agent = options.agent;
    this.locks = options.locks;
    this.treesDir = options.treesDir;
    this.allowPrivateUrls = options.allowPrivateUrls ?? false;
    this.timings = { ...DEFAULT_QUESTION_TIMINGS, ...options.timings };
    this.log = options.log ?? silentLogger;
    this.hooks = options.hooks ?? {};
    this.held = createHeldFiles({ root: options.heldDir });
    this.registry = new QuestionRegistry({
      timings: this.timings,
      onRemoved: (info) => {
        // Files of a failed question are held until it is removed. A retry being prepared
        // owns them (it re-holds or discards them itself).
        if (info.status !== 'failed' || this.preparing.has(info.id)) return;
        this.held
          .discard(info.id)
          .catch((error: unknown) => this.log.error(error, `Could not delete held files`));
      },
    });
  }

  get instance(): string {
    return this.registry.instance;
  }

  subscribe(options: SubscribeOptions): Subscription {
    return this.registry.subscribe(options);
  }

  settled(id: string): Promise<QuestionInfo | undefined> {
    return this.registry.settled(id);
  }

  get(id: string): QuestionInfo | undefined {
    return this.registry.get(id);
  }

  detail(id: string): QuestionDetail | undefined {
    return this.registry.detail(id);
  }

  list(tree?: string): QuestionDetail[] {
    return this.registry.list(tree);
  }

  blockers(treeId: string, holders: readonly string[]): TreeBusyDetails {
    return this.registry.blockers(treeId, holders);
  }

  remap(tree: string, map: Record<string, string>): void {
    this.registry.remap(tree, map);
  }

  dropUnder(tree: string, ids: string[]): void {
    this.registry.dropUnder(tree, ids);
  }

  renameTree(oldId: string, newId: string): void {
    this.registry.renameTree(oldId, newId);
  }

  /** Register a prepared question (status `streaming`, attempt 1) and start answering it. */
  start(input: StartQuestionInput): QuestionInfo {
    const now = new Date().toISOString();
    const files = sortByName(input.files);
    const fileNames = files.map((file) => file.name);
    const info: RunningQuestion = {
      id: input.id,
      tree: input.tree,
      parentId: input.parentId,
      context: input.context,
      text: input.text,
      title: questionTitle(input.text, fileNames),
      files,
      model: input.model,
      namingModel: input.namingModel,
      attempt: 1,
      status: 'streaming',
      createdAt: now,
      updatedAt: now,
    };
    this.registry.add(info);
    this.run({
      id: info.id,
      attempt: 1,
      treeDir: input.treeDir,
      parentId: input.parentId,
      text: input.text,
      question: agentQuestion(input.text),
      namingQuestion: namingQuestion(input.text, fileNames),
      model: input.model,
      namingModel: input.namingModel,
      instructions: input.instructions,
      chain: input.chain,
      promptFiles: input.promptFiles,
      staging: input.staging,
      controller: input.controller,
      release: input.release,
      committing: false,
      finished: Promise.resolve(),
    });
    return info;
  }

  /**
   * Re-run a failed question under its CURRENT tree and parent, with its held files. On any
   * error before the new attempt starts the entry stays failed and keeps its files.
   */
  async retry(id: string): Promise<QuestionInfo> {
    const info = this.registry.get(id);
    if (!info) throw questionNotFound(id);
    if (info.status !== 'failed' || this.preparing.has(id)) {
      throw new ConflictError(
        `Question ${id} is not failed: only failed questions can be retried`,
        'question_not_failed',
      );
    }
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.preparing.set(id, { controller, done });
    try {
      return await this.prepareRetry(info, controller.signal);
    } finally {
      this.preparing.delete(id);
      finish();
    }
  }

  /**
   * DELETE: cancel a running question (waits for the teardown) or dismiss a failed one. A
   * commit in progress is awaited first; `done` → 409 `question_finished`.
   */
  async remove(id: string): Promise<void> {
    let cancelled = false;
    for (;;) {
      const preparation = this.preparing.get(id);
      if (preparation) {
        preparation.controller.abort();
        await preparation.done;
        continue;
      }
      const info = this.registry.get(id);
      if (!info) {
        if (cancelled) return;
        throw questionNotFound(id);
      }
      if (info.status === 'done') {
        throw new ConflictError(
          `Question ${id} already produced node "${info.nodeId}"`,
          'question_finished',
          { nodeId: info.nodeId },
        );
      }
      if (info.status === 'failed') {
        this.registry.remove(id, 'dismissed');
        return;
      }
      const job = this.jobs.get(id);
      if (!job) {
        // Not expected: a running entry always has a job until its terminal event.
        this.registry.remove(id, 'cancelled');
        return;
      }
      if (!job.committing) {
        job.controller.abort('cancel');
        cancelled = true;
      }
      await job.finished;
    }
  }

  /** End every event stream (Fastify `preClose`, so the HTTP server can close). */
  endStreams(): void {
    this.registry.endSubscribers();
  }

  /** Abort running attempts and retries being prepared (no events), then drop everything. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending: Promise<unknown>[] = [];
    for (const preparation of this.preparing.values()) {
      preparation.controller.abort();
      pending.push(preparation.done);
    }
    for (const job of this.jobs.values()) {
      job.controller.abort('shutdown');
      pending.push(job.finished);
    }
    await Promise.allSettled(pending);
    this.registry.close();
    await this.held.close().catch((error: unknown) => this.log.error(error));
  }

  private get runnerDeps(): RunnerDeps {
    return {
      agent: this.agent,
      registry: this.registry,
      held: this.held,
      timings: this.timings,
      log: this.log,
      hooks: this.hooks,
    };
  }

  private run(job: QuestionJob): void {
    this.jobs.set(job.id, job);
    job.finished = runAttempt(job, this.runnerDeps).finally(() => {
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    });
  }

  private async prepareRetry(info: QuestionInfo, prep: AbortSignal): Promise<QuestionInfo> {
    const { id, tree, parentId } = info;
    const attempt = info.attempt + 1;
    // 409 `tree_busy_structural` while a structural op runs; the question id is the holder.
    const release = this.locks.acquireShared(tree, id);
    const controller = new AbortController();
    const onPrepAbort = () => controller.abort('cancel');
    prep.addEventListener('abort', onPrepAbort, { once: true });
    let staging: AnswerStaging | undefined;
    let restored = false;
    try {
      const treeDir = await existingTreeDir(this.treesDir, tree);
      const meta = await readTree(this.treesDir, tree);
      const chain = await readChain(treeDir, parentId).catch(parentNotFound(parentId));
      const parentDir = nodeDirOf(treeDir, parentId);
      await sweepStaleStaging(parentDir);
      staging = await createAnswerStaging({
        parentDir,
        signal: controller.signal,
        allowPrivateUrls: this.allowPrivateUrls,
        onEvent: (event) => this.registry.attachment(id, attempt, event),
      });
      if (info.files.length > 0) {
        await this.held.restore(id, staging.dir);
        restored = true;
      }
      const { files, prompt } = await stagedPromptFiles(treeDir, staging.dir);
      if (prep.aborted) throw questionNotFound(id);
      const current = this.registry.get(id);
      if (current?.status !== 'failed') throw questionNotFound(id);
      const started = this.registry.beginAttempt(id);
      if (!started) throw questionNotFound(id);
      const fileNames = sortByName(files).map((file) => file.name);
      this.run({
        id,
        attempt,
        treeDir,
        parentId: started.parentId,
        text: started.text,
        question: agentQuestion(started.text),
        namingQuestion: namingQuestion(started.text, fileNames),
        model: started.model,
        namingModel: started.namingModel,
        instructions: meta.instructions,
        chain,
        promptFiles: prompt,
        staging,
        controller,
        release,
        committing: false,
        finished: Promise.resolve(),
      });
      return started;
    } catch (error) {
      // The entry stays failed and keeps its files (unless it was removed meanwhile).
      const stillFailed = this.registry.get(id)?.status === 'failed';
      if (staging) {
        if (restored && stillFailed) {
          await this.held
            .hold(id, staging.dir)
            .catch((cause: unknown) => this.log.error(cause, `Could not keep files of ${id}`));
        }
        await staging.discard().catch((cause: unknown) => this.log.error(cause));
      }
      if (!stillFailed) await this.held.discard(id).catch(() => undefined);
      release();
      // Aborted by DELETE (the question is dismissed next) or by shutdown.
      if (prep.aborted) throw questionNotFound(id);
      if (!(error instanceof AppError)) this.log.error(error, `Retry of question ${id} failed`);
      throw error;
    } finally {
      prep.removeEventListener('abort', onPrepAbort);
    }
  }
}

function sortByName(files: UserFileInfo[]): UserFileInfo[] {
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
