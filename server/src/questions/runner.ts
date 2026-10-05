import { type Agent, type AgentEvent, fallbackNodeName } from '../agent/index.js';
import {
  type AnswerStaging,
  type ChainNode,
  createNode,
  type HeldFiles,
  listAttachments,
  listUserFiles,
  nodeDirOf,
  type PromptFile,
} from '../storage/index.js';
import type { QuestionRegistry } from './registry.js';
import type {
  QuestionFailureCode,
  QuestionHooks,
  QuestionLogger,
  QuestionTimings,
} from './types.js';

/** Why an attempt's controller was aborted. Only `timeout` turns into a failure. */
export type AbortReason = 'cancel' | 'timeout' | 'shutdown';

/** One attempt of one question. Owned by the service; the runner never touches the request. */
export interface QuestionJob {
  id: string;
  attempt: number;
  treeDir: string;
  parentId: string;
  /** User text stored in `node.md` (`""` for a files-only message). */
  text: string;
  /** What the agent is asked (`text` or EMPTY_TEXT_QUESTION). */
  question: string;
  /** What the naming call sees as the question. */
  namingQuestion: string;
  model: string;
  namingModel: string;
  instructions: string;
  chain: ChainNode[];
  promptFiles: PromptFile[];
  staging: AnswerStaging;
  /** Aborted with an `AbortReason` by DELETE (`cancel`), the watchdog or shutdown. */
  controller: AbortController;
  /** Releases this attempt's shared tree lock. Idempotent. */
  release: () => void;
  /** Set (synchronously with the last abort check) right before the commit starts. */
  committing: boolean;
  /** Settles when the attempt is fully torn down (never rejects). */
  finished: Promise<void>;
}

export interface RunnerDeps {
  agent: Agent;
  registry: QuestionRegistry;
  held: HeldFiles;
  timings: QuestionTimings;
  log: QuestionLogger;
  hooks?: QuestionHooks;
}

class AttemptAborted extends Error {
  constructor(readonly reason: unknown) {
    super('Aborted');
  }
}

/** Failure outside the agent (sealing, committing, disk). */
class ServerSideError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AttemptAborted(signal.reason);
}

async function serverSide<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw error instanceof AttemptAborted ? error : new ServerSideError(error);
  }
}

/** `.catch` handler for listing a committed node: log and report nothing. */
function logEmpty(deps: RunnerDeps, nodeId: string) {
  return (error: unknown): never[] => {
    deps.log.error(error, `Could not list the files of node ${nodeId}`);
    return [];
  };
}

function describeDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * Run one attempt: ask the agent (chunks → registry), seal the attachments, name the node
 * from the question and the answer, commit the staging folder as the node. The lock is
 * released before the terminal event (`done` / `failed` / `removed{cancelled}`). Never throws.
 */
export async function runAttempt(job: QuestionJob, deps: RunnerDeps): Promise<void> {
  const { agent, registry, timings } = deps;
  const { controller, staging } = job;
  const signal = controller.signal;
  const timeout: AbortReason = 'timeout';
  const watchdog = setTimeout(() => controller.abort(timeout), timings.attemptTimeoutMs);
  watchdog.unref?.();
  try {
    let answer: Extract<AgentEvent, { type: 'done' }> | undefined;
    const events = agent.ask({
      treeDir: job.treeDir,
      instructions: job.instructions,
      chain: job.chain,
      question: job.question,
      files: job.promptFiles,
      model: job.model,
      signal,
      staging,
      stagingDir: staging.dir,
    });
    for await (const event of events) {
      if (signal.aborted) break;
      if (event.type === 'chunk') registry.appendChunk(job.id, job.attempt, event.text);
      else answer = event;
    }
    throwIfAborted(signal);
    if (!answer) throw new Error('Agent finished without an answer');
    const final = answer;

    // All attachment events land before `naming`; drops an empty `attachments/`.
    await serverSide(() => staging.seal());
    throwIfAborted(signal);
    registry.setNaming(job.id, job.attempt);

    let name: string;
    try {
      name = await agent.name({
        question: job.namingQuestion,
        answer: final.text,
        model: job.namingModel,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timings.namingTimeoutMs)]),
      });
    } catch (error) {
      throwIfAborted(signal);
      deps.log.warn(error, `Naming failed for question ${job.id}; using the fallback name`);
      name = fallbackNodeName(job.namingQuestion);
    }

    // Commit point: the last abort check and the flag in one tick. From here on DELETE waits
    // for the outcome instead of cancelling.
    throwIfAborted(signal);
    job.committing = true;
    clearTimeout(watchdog);
    const nodeId = await serverSide(async () => {
      await deps.hooks?.beforeCommit?.(job.id);
      return createNode(
        job.treeDir,
        job.parentId,
        name,
        {
          created: new Date().toISOString(),
          model: final.model,
          user: job.text,
          assistant: final.text,
        },
        { stagingDir: staging.dir },
      );
    });
    // The node exists from here on: the question is done whatever happens next.
    // Renamed into the node: sweeps may consider the staging path again.
    staging.release();
    const nodeDir = nodeDirOf(job.treeDir, nodeId);
    const attachments = await listAttachments(nodeDir).catch(logEmpty(deps, nodeId));
    const files = await listUserFiles(nodeDir).catch(logEmpty(deps, nodeId));
    job.release();
    registry.complete(job.id, job.attempt, { nodeId, attachments, files });
  } catch (error) {
    await settleFailure(job, deps, error).catch((cause: unknown) =>
      deps.log.error(cause, `Could not tear down question ${job.id}`),
    );
  } finally {
    clearTimeout(watchdog);
  }
}

/** Teardown after an error or abort: cancel, shutdown or failure (files held for retry). */
async function settleFailure(job: QuestionJob, deps: RunnerDeps, error: unknown): Promise<void> {
  const { registry, log } = deps;
  const { staging, controller } = job;
  const reason = controller.signal.aborted ? controller.signal.reason : undefined;

  if (reason === 'cancel' || reason === 'shutdown') {
    await staging.discard().catch((cause: unknown) => log.error(cause));
    job.release();
    if (reason === 'cancel') registry.remove(job.id, 'cancelled');
    return;
  }

  let code: QuestionFailureCode = 'agent_error';
  let message = error instanceof Error ? error.message : String(error);
  if (reason === 'timeout') {
    code = 'timeout';
    message = `The answer took longer than ${describeDuration(deps.timings.attemptTimeoutMs)} and was stopped.`;
  } else if (error instanceof ServerSideError) {
    code = 'internal';
    log.error(error.cause, `Question ${job.id} failed`);
  } else {
    log.error(error, `Question ${job.id} failed`);
  }

  // Stop in-flight attachment saves (the reason was read above), let them settle, then take
  // the folder apart. Attachments of a failed attempt are dropped; user files are held.
  if (!controller.signal.aborted) controller.abort();
  await staging.seal().catch(() => undefined);
  await deps.held
    .hold(job.id, staging.dir)
    .catch((cause: unknown) => log.error(cause, `Could not keep the files of question ${job.id}`));
  await staging.discard().catch((cause: unknown) => log.error(cause));
  job.release();
  registry.fail(job.id, job.attempt, { message, code });
}
