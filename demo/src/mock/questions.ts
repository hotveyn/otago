/**
 * In-flight questions, simulated: the registry, runner and service of `server/src/questions/`
 * in one class. Answers are Lorem ipsum streamed word by word; the node is committed to the
 * VFS like the server's `createNode`. Events have the shapes of the SSE contract
 * (`web/src/api/types.ts`) and reach the store through `connection.ts`.
 * The registry lives in memory: a page reload loses running questions (a "server restart").
 */
import { collapseWhitespace, firstLine, truncateGraphemes } from '../../../server/src/text';
import type {
  BlockingQuestion,
  DoneQuestion,
  FailedQuestion,
  ModelsInfo,
  QuestionContext,
  QuestionDetail,
  QuestionError,
  QuestionInfo,
  QuestionLive,
  QuestionRemovedReason,
  QuestionStreamEvent,
  RunningQuestion,
  SnapshotEventData,
  TreeBusyDetails,
  UserFileInfo,
} from '../../../web/src/api/types';
import { badRequest, conflict, notFound, payloadTooLarge } from './errors';
import { DEMO_MAX_FILE_BYTES, fileInfoOf, MAX_MESSAGE_FILES, userFileNameOf } from './files';
import type { TreeLocks } from './locks';
import { loremAnswer, streamTokens } from './lorem';
import { isSameOrDescendant, toNodeName, uniqueFileName } from './names';
import type { StoredFile, TreeStore } from './trees';

export type Schedule = (fn: () => void, ms: number) => () => void;

export const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export interface QuestionsOptions {
  trees: TreeStore;
  models: ModelsInfo;
  now?: () => number;
  random?: () => number;
  schedule?: Schedule;
  uuid?: () => string;
}

export interface StartInput {
  parentId: string;
  text?: string;
  model?: string;
  namingModel?: string;
  context?: QuestionContext;
  files?: readonly File[];
}

type Listener = (event: QuestionStreamEvent) => void;

interface Entry {
  info: QuestionInfo;
  live: QuestionLive | null;
  /** Bytes of the user files: committed with the node, kept for a retry. */
  files: StoredFile[];
  release: (() => void) | null;
  cancelRun: (() => void) | null;
  cancelExpiry: (() => void) | null;
}

const MAX_TEXT_LENGTH = 50_000;
const TITLE_MAX_GRAPHEMES = 80;
const DONE_RETENTION_MS = 30 * 60 * 1000;
const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;
const FAIL_WORD_RE = /\bfail\b/i;

/** Display title: first non-empty line (or the file names), ≤ 80 graphemes + `…`. */
export function questionTitle(text: string, fileNames: readonly string[]): string {
  const line = collapseWhitespace(firstLine(text));
  return truncateGraphemes(line || fileNames.join(', '), TITLE_MAX_GRAPHEMES, '…');
}

const isRunning = (info: QuestionInfo): info is RunningQuestion =>
  info.status === 'streaming' || info.status === 'naming';

export class Questions {
  /** A new value per page load: the store treats it like a server restart. */
  readonly instance: string;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<Listener>();
  private readonly trees: TreeStore;
  private readonly models: ModelsInfo;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: Schedule;
  private readonly uuid: () => string;
  private locks: TreeLocks | null = null;

  constructor(options: QuestionsOptions) {
    this.trees = options.trees;
    this.models = options.models;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? defaultSchedule;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.instance = this.uuid();
  }

  /** The locks are created with `blockers` of this instance, so they are set afterwards. */
  attachLocks(locks: TreeLocks): void {
    this.locks = locks;
  }

  private get lock(): TreeLocks {
    if (!this.locks) throw new Error('Questions: locks are not attached');
    return this.locks;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QuestionStreamEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private emitQuestion(entry: Entry): void {
    this.emit({ event: 'question', data: { question: entry.info } });
  }

  snapshot(): SnapshotEventData {
    const questions: QuestionDetail[] = [...this.entries.values()]
      .sort((a, b) => a.info.createdAt.localeCompare(b.info.createdAt))
      .map((entry) => ({ ...entry.info, live: entry.info.status === 'done' ? null : entry.live }));
    return { instance: this.instance, questions };
  }

  /** `details` of a 409 `tree_busy_streaming`. */
  blockers(treeId: string, holders: string[]): TreeBusyDetails {
    const running = [...this.entries.values()]
      .map((entry) => entry.info)
      .filter((info): info is RunningQuestion => info.tree === treeId && isRunning(info))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const questions: BlockingQuestion[] = running.map(
      ({ id, tree, parentId, context, title, status }) => ({
        id,
        tree,
        parentId,
        context,
        title,
        status,
      }),
    );
    const runningIds = new Set(running.map((info) => info.id));
    return { questions, preparing: holders.filter((holder) => !runningIds.has(holder)).length };
  }

  // --- Routes -----------------------------------------------------------------------------

  /** `POST /trees/:tree/questions` (202). */
  async start(treeId: string, input: StartInput, signal?: AbortSignal): Promise<QuestionInfo> {
    const text = (input.text ?? '').trim();
    if (text.length > MAX_TEXT_LENGTH) throw badRequest('Invalid input');
    const model = input.model ?? this.models.defaults.answer;
    const namingModel = input.namingModel ?? this.models.defaults.naming;
    for (const name of [model, namingModel]) {
      if (!this.models.models.includes(name)) {
        throw badRequest(`Unknown model "${name}". Available: ${this.models.models.join(', ')}`);
      }
    }
    const context: QuestionContext = input.context ?? { kind: 'main' };
    if (context.kind === 'side' && !isSameOrDescendant(input.parentId, context.anchor)) {
      throw badRequest('Invalid context: the anchor must be the parent or one of its ancestors');
    }
    this.trees.assertTree(treeId);
    const id = this.uuid();
    const release = this.lock.acquireShared(treeId, id);
    try {
      if (!this.trees.nodeExists(treeId, input.parentId)) {
        throw notFound(`Parent node not found: ${input.parentId}`, 'parent_not_found');
      }
      const files = await this.stageFiles(input.files ?? []);
      signal?.throwIfAborted();
      if (!text && files.length === 0) {
        throw badRequest('Message is empty: type a question or attach a file', 'empty_message');
      }
      const at = new Date(this.now()).toISOString();
      const entry: Entry = {
        info: {
          id,
          tree: treeId,
          parentId: input.parentId,
          context,
          text,
          title: questionTitle(
            text,
            files.map((file) => file.name),
          ),
          files: this.fileInfos(files),
          model,
          namingModel,
          attempt: 1,
          status: 'streaming',
          createdAt: at,
          updatedAt: at,
        },
        live: { attempt: 1, answer: '', attachments: [] },
        files,
        release,
        cancelRun: null,
        cancelExpiry: null,
      };
      this.entries.set(id, entry);
      this.emitQuestion(entry);
      this.run(entry);
      return entry.info;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** `DELETE /questions/:id`: cancel a running question or dismiss a failed one (204). */
  async cancel(id: string): Promise<void> {
    const entry = this.require(id);
    const { info } = entry;
    if (info.status === 'done') {
      throw conflict('The question is already answered', 'question_finished', {
        nodeId: info.nodeId,
      });
    }
    this.remove(entry, info.status === 'failed' ? 'dismissed' : 'cancelled');
  }

  /** `POST /questions/:id/retry` (202): same id, `attempt + 1`. */
  async retry(id: string): Promise<QuestionInfo> {
    const entry = this.require(id);
    if (entry.info.status !== 'failed') {
      throw conflict('Only a failed question can be retried', 'question_not_failed');
    }
    const { tree, parentId } = entry.info;
    const release = this.lock.acquireShared(tree, id);
    try {
      this.trees.assertTree(tree);
      if (!this.trees.nodeExists(tree, parentId)) {
        throw notFound(`Parent node not found: ${parentId}`, 'parent_not_found');
      }
    } catch (error) {
      release();
      throw error;
    }
    entry.cancelExpiry?.();
    entry.cancelExpiry = null;
    const { error: _error, status: _status, ...base } = entry.info;
    const attempt = base.attempt + 1;
    entry.info = {
      ...base,
      attempt,
      status: 'streaming',
      updatedAt: new Date(this.now()).toISOString(),
    };
    entry.live = { attempt, answer: '', attachments: [] };
    entry.release = release;
    this.emitQuestion(entry);
    this.run(entry);
    return entry.info;
  }

  // --- Structural changes (retained entries follow the tree) ------------------------------

  /** Moves/renames: remap `parentId`, side anchor and done `nodeId` by id prefix. */
  remap(treeId: string, mapping: Record<string, string>): void {
    const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
    const remapId = (id: string) => {
      const key = keys.find((k) => id === k || id.startsWith(`${k}/`));
      return key === undefined ? id : `${mapping[key]}${id.slice(key.length)}`;
    };
    for (const entry of this.entries.values()) {
      const { info } = entry;
      if (info.tree !== treeId || isRunning(info)) continue;
      const parentId = remapId(info.parentId);
      let context = info.context;
      if (context.kind === 'side') {
        const anchor = remapId(context.anchor);
        context = {
          kind: 'side',
          anchor: isSameOrDescendant(parentId, anchor) ? anchor : parentId,
        };
      }
      const nodeId = info.status === 'done' ? remapId(info.nodeId) : undefined;
      const changed =
        parentId !== info.parentId ||
        JSON.stringify(context) !== JSON.stringify(info.context) ||
        (info.status === 'done' && nodeId !== info.nodeId);
      if (!changed) continue;
      entry.info = {
        ...info,
        parentId,
        context,
        ...(info.status === 'done' && { nodeId }),
        updatedAt: new Date(this.now()).toISOString(),
      } as QuestionInfo;
      this.emitQuestion(entry);
    }
  }

  /** Delete: entries whose parent or node was inside a deleted subtree are removed. */
  dropUnder(treeId: string, deletedIds: string[]): void {
    const inside = (id: string) => deletedIds.some((deleted) => isSameOrDescendant(id, deleted));
    for (const entry of [...this.entries.values()]) {
      const { info } = entry;
      if (info.tree !== treeId || isRunning(info)) continue;
      if (inside(info.parentId) || (info.status === 'done' && inside(info.nodeId))) {
        this.remove(entry, 'deleted');
      }
    }
  }

  /** Tree rename: every entry of the tree gets the new id. */
  renameTree(oldId: string, newId: string): void {
    if (oldId === newId) return;
    for (const entry of this.entries.values()) {
      if (entry.info.tree !== oldId) continue;
      entry.info = { ...entry.info, tree: newId };
      this.emitQuestion(entry);
    }
  }

  // --- Simulation -------------------------------------------------------------------------

  private run(entry: Entry): void {
    const { id, attempt, text } = entry.info;
    const tokens = streamTokens(loremAnswer(this.random));
    const failAt =
      attempt === 1 && FAIL_WORD_RE.test(text) ? Math.floor(tokens.length * 0.4) : Infinity;
    let index = 0;
    const tick = () => {
      if (!this.isCurrent(entry, id, attempt)) return;
      if (index >= failAt) {
        this.fail(entry, {
          code: 'agent_error',
          message:
            'Simulated failure: the question contains the word "fail". Retry to get an answer.',
        });
        return;
      }
      const live = entry.live;
      if (!live) return;
      const count = 1 + Math.floor(this.random() * 3);
      const chunk = tokens.slice(index, index + count).join('');
      index += count;
      if (chunk) {
        const offset = live.answer.length;
        live.answer += chunk;
        this.emit({
          event: 'chunk',
          data: { id, tree: entry.info.tree, attempt, offset, text: chunk },
        });
      }
      if (index < tokens.length) {
        entry.cancelRun = this.schedule(tick, 30 + Math.floor(this.random() * 40));
        return;
      }
      this.setStatus(entry, 'naming');
      entry.cancelRun = this.schedule(
        () => this.commit(entry, attempt),
        400 + Math.floor(this.random() * 300),
      );
    };
    entry.cancelRun = this.schedule(tick, 250 + Math.floor(this.random() * 250));
  }

  private commit(entry: Entry, attempt: number): void {
    if (!this.isCurrent(entry, entry.info.id, attempt) || !entry.live) return;
    const info = entry.info as RunningQuestion;
    const fileNames = entry.files.map((file) => file.name);
    const namingQuestion = info.text || `Attached files: ${fileNames.join(', ')}`;
    let nodeId: string;
    try {
      nodeId = this.trees.createNode(
        info.tree,
        info.parentId,
        toNodeName(namingQuestion, { maxWords: 4 }),
        {
          created: new Date(this.now()).toISOString(),
          model: info.model,
          user: info.text,
          assistant: entry.live.answer.trim(),
        },
        entry.files,
      );
    } catch (error) {
      this.fail(entry, {
        code: 'internal',
        message: error instanceof Error ? error.message : 'Could not save the answer',
      });
      return;
    }
    this.releaseLock(entry);
    entry.cancelRun = null;
    const { status: _status, ...base } = info;
    const done: DoneQuestion = {
      ...base,
      status: 'done',
      nodeId,
      attachments: [],
      updatedAt: new Date(this.now()).toISOString(),
    };
    entry.info = done;
    entry.live = null;
    entry.files = [];
    this.emitQuestion(entry);
    this.expireAfter(entry, DONE_RETENTION_MS);
  }

  private fail(entry: Entry, error: QuestionError): void {
    entry.cancelRun?.();
    entry.cancelRun = null;
    this.releaseLock(entry);
    const { status: _status, ...base } = entry.info as RunningQuestion;
    const failed: FailedQuestion = {
      ...base,
      status: 'failed',
      error,
      updatedAt: new Date(this.now()).toISOString(),
    };
    entry.info = failed;
    this.emitQuestion(entry);
    this.expireAfter(entry, FAILED_RETENTION_MS);
  }

  private setStatus(entry: Entry, status: RunningQuestion['status']): void {
    entry.info = {
      ...(entry.info as RunningQuestion),
      status,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.emitQuestion(entry);
  }

  private expireAfter(entry: Entry, ms: number): void {
    entry.cancelExpiry?.();
    entry.cancelExpiry = this.schedule(() => {
      if (this.entries.get(entry.info.id) === entry) this.remove(entry, 'expired');
    }, ms);
  }

  private remove(entry: Entry, reason: QuestionRemovedReason): void {
    entry.cancelRun?.();
    entry.cancelExpiry?.();
    this.releaseLock(entry);
    this.entries.delete(entry.info.id);
    const { info } = entry;
    this.emit({
      event: 'removed',
      data: {
        id: info.id,
        tree: info.tree,
        reason,
        ...(info.status === 'done' && { nodeId: info.nodeId }),
      },
    });
  }

  private releaseLock(entry: Entry): void {
    entry.release?.();
    entry.release = null;
  }

  private isCurrent(entry: Entry, id: string, attempt: number): boolean {
    return (
      this.entries.get(id) === entry && entry.info.attempt === attempt && isRunning(entry.info)
    );
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw notFound(`Question not found: ${id}`, 'question_not_found');
    return entry;
  }

  /** Validate user files in order and read them (`message-input.ts` rules, demo size cap). */
  private async stageFiles(files: readonly File[]): Promise<StoredFile[]> {
    if (files.length > MAX_MESSAGE_FILES) {
      throw badRequest(
        `Too many files: at most ${MAX_MESSAGE_FILES} per message`,
        'too_many_files',
      );
    }
    const taken = new Set<string>();
    const staged: StoredFile[] = [];
    for (const file of files) {
      const name = uniqueFileName(taken, userFileNameOf(file.name, file.type));
      if (file.size === 0) throw badRequest(`File "${file.name}" is empty`, 'empty_file');
      if (file.size > DEMO_MAX_FILE_BYTES) {
        throw payloadTooLarge(
          `File "${file.name}" is too large: the demo stores files in the browser and accepts up to ${DEMO_MAX_FILE_BYTES / 1024} KB per file`,
          'file_too_large',
        );
      }
      taken.add(name);
      staged.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    return staged;
  }

  private fileInfos(files: readonly StoredFile[]): UserFileInfo[] {
    return files
      .map((file) => fileInfoOf(file.name, file.bytes.length))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
