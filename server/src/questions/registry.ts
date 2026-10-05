import { randomUUID } from 'node:crypto';
import {
  type AttachmentEvent,
  type AttachmentInfo,
  isSameOrDescendant,
  type UserFileInfo,
} from '../storage/index.js';
import type {
  BlockingQuestion,
  DoneQuestion,
  FailedQuestion,
  QuestionBase,
  QuestionDeltaEvent,
  QuestionDetail,
  QuestionError,
  QuestionInfo,
  QuestionLive,
  QuestionRemovedReason,
  QuestionTimings,
  RegistryEvent,
  RunningQuestion,
  SnapshotEventData,
  TreeBusyDetails,
} from './types.js';

interface Entry {
  info: QuestionInfo;
  /** Live state of the current attempt; `null` once done. */
  live: QuestionLive | null;
  /** Retention timer of a done/failed entry. */
  timer?: NodeJS.Timeout;
  /** When the entry reached its current terminal status (cap eviction: lowest first). */
  settledOrder: number;
}

interface Subscriber {
  tree?: string;
  onEvent: (event: RegistryEvent) => void;
  onEnd: () => void;
}

export interface SubscribeOptions {
  /** Only events (and snapshot entries) whose current `tree` is this id. */
  tree?: string;
  onEvent: (event: RegistryEvent) => void;
  /** Called when the registry ends every stream (server shutdown). */
  onEnd: () => void;
}

export interface Subscription {
  /** State at subscription time; `seq` is the last sequence number it includes. */
  snapshot: SnapshotEventData & { seq: number };
  unsubscribe: () => void;
}

export interface QuestionRegistryOptions {
  timings: QuestionTimings;
  /** Called after an entry was removed (any reason), e.g. to delete held files. */
  onRemoved?: (info: QuestionInfo, reason: QuestionRemovedReason) => void;
}

export function isRunning(info: QuestionInfo): info is RunningQuestion {
  return info.status === 'streaming' || info.status === 'naming';
}

function baseOf(info: QuestionInfo): QuestionBase {
  const { id, tree, parentId, context, text, title, files, model, namingModel, attempt } = info;
  const { createdAt, updatedAt } = info;
  return {
    id,
    tree,
    parentId,
    context,
    text,
    title,
    files,
    model,
    namingModel,
    attempt,
    createdAt,
    updatedAt,
  };
}

function byCreated(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function treeOf(event: QuestionDeltaEvent): string {
  return event.event === 'question' ? event.data.question.tree : event.data.tree;
}

/** `id` after the moves/renames in `pairs` (prefix rule, longest old id first). */
function remapId(id: string, pairs: Array<[string, string]>): string {
  for (const [from, to] of pairs) {
    if (id === from || id.startsWith(`${from}/`)) return to + id.slice(from.length);
  }
  return id;
}

/**
 * In-flight questions of this process: state, events, retention and remapping. Synchronous and
 * free of I/O (no agent, disk or locks); every mutation emits exactly the events of the
 * contract (`question-events.ts`) in the same tick.
 */
export class QuestionRegistry {
  /** Random id of this server process (clients detect restarts with it). */
  readonly instance = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly waiters = new Map<string, Set<(info: QuestionInfo | undefined) => void>>();
  private seq = 0;
  private order = 0;
  private closed = false;

  constructor(private readonly options: QuestionRegistryOptions) {}

  /* --- mutations ------------------------------------------------------------------------ */

  /** Register a new question (status `streaming`). */
  add(info: RunningQuestion): void {
    if (this.closed) return;
    this.entries.set(info.id, {
      info,
      live: { attempt: info.attempt, answer: '', attachments: [] },
      settledOrder: 0,
    });
    this.emitQuestion(info);
  }

  /** Next answer text of `attempt`. Ignored unless the entry streams that attempt. */
  appendChunk(id: string, attempt: number, text: string): void {
    const entry = this.current(id, attempt, 'streaming');
    if (!entry?.live || !text) return;
    const offset = entry.live.answer.length;
    entry.live.answer += text;
    this.emit({ event: 'chunk', data: { id, tree: entry.info.tree, attempt, offset, text } });
  }

  /**
   * Attachment progress of `attempt`, folded into `live.attachments` (latest event per key).
   * Only while streaming: late events after the seal are dropped.
   */
  attachment(id: string, attempt: number, event: AttachmentEvent): void {
    const entry = this.current(id, attempt, 'streaming');
    if (!entry?.live) return;
    const list = entry.live.attachments;
    const index = list.findIndex((item) => item.key === event.key);
    if (index === -1) list.push(event);
    else list[index] = event;
    this.emit({ event: 'attachment', data: { id, tree: entry.info.tree, attempt, event } });
  }

  /** The answer of `attempt` is complete; the node is being named and committed. */
  setNaming(id: string, attempt: number): void {
    const entry = this.current(id, attempt, 'streaming');
    if (!entry) return;
    this.update(entry, { ...baseOf(entry.info), status: 'naming', updatedAt: now() });
  }

  /** The node of `attempt` exists on disk. Drops the live text and starts the done TTL. */
  complete(
    id: string,
    attempt: number,
    result: { nodeId: string; attachments: AttachmentInfo[]; files: UserFileInfo[] },
  ): void {
    const entry = this.current(id, attempt);
    if (!entry) return;
    const info: DoneQuestion = {
      ...baseOf(entry.info),
      files: result.files,
      status: 'done',
      nodeId: result.nodeId,
      attachments: result.attachments,
      updatedAt: now(),
    };
    entry.live = null;
    this.settle(entry, info, this.options.timings.doneTtlMs, 'expired');
    this.enforceCap(info.tree, 'done', this.options.timings.doneCapPerTree, 'expired');
  }

  /** `attempt` failed. Keeps the partial live text and starts the failed TTL. */
  fail(id: string, attempt: number, error: QuestionError): void {
    const entry = this.current(id, attempt);
    if (!entry) return;
    const info: FailedQuestion = {
      ...baseOf(entry.info),
      status: 'failed',
      error,
      updatedAt: now(),
    };
    this.settle(entry, info, this.options.timings.failedTtlMs, 'expired');
    this.enforceCap(info.tree, 'failed', this.options.timings.failedCapPerTree, 'evicted');
  }

  /** Retry: failed → streaming with `attempt + 1` and a fresh live state. */
  beginAttempt(id: string): RunningQuestion | undefined {
    const entry = this.entries.get(id);
    if (entry?.info.status !== 'failed') return undefined;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const attempt = entry.info.attempt + 1;
    const info: RunningQuestion = {
      ...baseOf(entry.info),
      status: 'streaming',
      attempt,
      updatedAt: now(),
    };
    entry.live = { attempt, answer: '', attachments: [] };
    this.update(entry, info);
    return info;
  }

  /** Remove an entry; emits `removed` (with `nodeId` for done). False when unknown. */
  remove(id: string, reason: QuestionRemovedReason): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    const { info } = entry;
    this.emit({
      event: 'removed',
      data: {
        id,
        tree: info.tree,
        reason,
        ...(info.status === 'done' ? { nodeId: info.nodeId } : {}),
      },
    });
    try {
      this.options.onRemoved?.(info, reason);
    } catch {
      // Cleanup errors must not break the registry.
    }
    this.resolveWaiters(id, undefined);
    return true;
  }

  /**
   * After a move/rename in `tree` (old id → new id): rewrite `parentId`, `context.anchor` and
   * done `nodeId` of retained entries by prefix; a side anchor that is no longer the parent or
   * an ancestor becomes the parent. Emits `question` for changed entries only.
   */
  remap(tree: string, map: Record<string, string>): void {
    const pairs = Object.entries(map)
      .filter(([from, to]) => from !== '' && from !== to)
      .sort((a, b) => b[0].length - a[0].length);
    if (pairs.length === 0) return;
    for (const entry of [...this.entries.values()]) {
      const { info } = entry;
      if (info.tree !== tree || isRunning(info)) continue;
      const parentId = remapId(info.parentId, pairs);
      let context = info.context;
      if (context.kind === 'side') {
        let anchor = remapId(context.anchor, pairs);
        if (!isSameOrDescendant(parentId, anchor)) anchor = parentId;
        if (anchor !== context.anchor) context = { kind: 'side', anchor };
      }
      const nodeId = info.status === 'done' ? remapId(info.nodeId, pairs) : undefined;
      const nodeChanged = info.status === 'done' && nodeId !== info.nodeId;
      if (parentId === info.parentId && context === info.context && !nodeChanged) continue;
      const updatedAt = now();
      this.update(
        entry,
        info.status === 'done'
          ? { ...info, parentId, context, nodeId: nodeId ?? info.nodeId, updatedAt }
          : { ...info, parentId, context, updatedAt },
      );
    }
  }

  /**
   * After a delete in `tree`: remove retained entries whose parent (or done node) is one of
   * `ids` or inside one (`removed{deleted}`).
   */
  dropUnder(tree: string, ids: string[]): void {
    const roots = ids.filter((id) => id !== '');
    const inside = (id: string) => roots.some((root) => isSameOrDescendant(id, root));
    const dropped = [...this.entries.values()]
      .map((entry) => entry.info)
      .filter(
        (info) =>
          info.tree === tree &&
          !isRunning(info) &&
          (inside(info.parentId) || (info.status === 'done' && inside(info.nodeId))),
      );
    for (const info of dropped) this.remove(info.id, 'deleted');
  }

  /** After a tree rename: rewrite `tree` on every entry of the old id. */
  renameTree(oldId: string, newId: string): void {
    if (oldId === newId) return;
    for (const entry of [...this.entries.values()]) {
      if (entry.info.tree !== oldId) continue;
      this.update(entry, { ...entry.info, tree: newId, updatedAt: now() });
    }
  }

  /* --- reads ---------------------------------------------------------------------------- */

  get(id: string): QuestionInfo | undefined {
    return this.entries.get(id)?.info;
  }

  detail(id: string): QuestionDetail | undefined {
    const entry = this.entries.get(id);
    return entry ? detailOf(entry) : undefined;
  }

  /** Every retained question (or those of `tree`), sorted by `createdAt`. */
  list(tree?: string): QuestionDetail[] {
    return [...this.entries.values()]
      .filter((entry) => tree === undefined || entry.info.tree === tree)
      .map(detailOf)
      .sort(byCreated);
  }

  /**
   * `details` of a 409 `tree_busy_streaming`: holders with a running question of the tree are
   * listed; the others (uploads, retries being prepared) are counted as `preparing`.
   */
  blockers(treeId: string, holders: readonly string[]): TreeBusyDetails {
    const running: RunningQuestion[] = [];
    let preparing = 0;
    for (const holder of new Set(holders)) {
      const info = this.entries.get(holder)?.info;
      if (info && isRunning(info) && info.tree === treeId) running.push(info);
      else preparing++;
    }
    const questions = running
      .sort(byCreated)
      .map(({ id, tree, parentId, context, title, status }): BlockingQuestion => {
        return { id, tree, parentId, context, title, status };
      });
    return { questions, preparing };
  }

  /**
   * Snapshot and listener registration in one synchronous call: every later event happened
   * after the snapshot (nothing missed, nothing duplicated). Listener errors are swallowed.
   */
  subscribe(options: SubscribeOptions): Subscription {
    const subscriber: Subscriber = { ...options };
    if (!this.closed) this.subscribers.add(subscriber);
    return {
      snapshot: { seq: this.seq, instance: this.instance, questions: this.list(options.tree) },
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }

  /**
   * Resolves with the entry on the next `done`/`failed`, with `undefined` on removal; at once
   * when the entry is already terminal (or unknown).
   */
  settled(id: string): Promise<QuestionInfo | undefined> {
    const info = this.entries.get(id)?.info;
    if (!info || !isRunning(info)) return Promise.resolve(info);
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      set.add(resolve);
    });
  }

  /** End every subscriber (server shutdown, before the HTTP server closes). */
  endSubscribers(): void {
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.onEnd();
      } catch {
        // A broken stream must not stop the others.
      }
    }
  }

  /** Clear timers, drop entries, settle waiters. No events after this. */
  close(): void {
    this.endSubscribers();
    this.closed = true;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    for (const id of [...this.waiters.keys()]) this.resolveWaiters(id, undefined);
  }

  /* --- internals ------------------------------------------------------------------------ */

  /** Entry running `attempt` (optionally in exactly `status`). */
  private current(id: string, attempt: number, status?: RunningQuestion['status']) {
    const entry = this.entries.get(id);
    if (!entry || !isRunning(entry.info) || entry.info.attempt !== attempt) return undefined;
    if (status && entry.info.status !== status) return undefined;
    return entry;
  }

  private update(entry: Entry, info: QuestionInfo): void {
    entry.info = info;
    this.emitQuestion(info);
  }

  /** Terminal status: emit, wake `settled` waiters, schedule the retention timer. */
  private settle(
    entry: Entry,
    info: DoneQuestion | FailedQuestion,
    ttlMs: number,
    reason: QuestionRemovedReason,
  ): void {
    entry.settledOrder = ++this.order;
    clearTimeout(entry.timer);
    const timer = setTimeout(() => this.remove(info.id, reason), ttlMs);
    timer.unref?.();
    entry.timer = timer;
    this.update(entry, info);
    this.resolveWaiters(info.id, info);
  }

  /** Keep at most `cap` entries of `status` in `tree` (oldest removed first). */
  private enforceCap(
    tree: string,
    status: 'done' | 'failed',
    cap: number,
    reason: QuestionRemovedReason,
  ): void {
    const matching = [...this.entries.values()]
      .filter((entry) => entry.info.tree === tree && entry.info.status === status)
      .sort((a, b) => a.settledOrder - b.settledOrder);
    const excess = matching.length - Math.max(0, cap);
    for (const entry of matching.slice(0, Math.max(0, excess))) {
      this.remove(entry.info.id, reason);
    }
  }

  private resolveWaiters(id: string, info: QuestionInfo | undefined): void {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const resolve of set) resolve(info);
  }

  private emitQuestion(info: QuestionInfo): void {
    this.emit({ event: 'question', data: { question: info } });
  }

  private emit(event: QuestionDeltaEvent): void {
    if (this.closed) return;
    const full = { ...event, seq: ++this.seq } as RegistryEvent;
    const tree = treeOf(event);
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.tree !== undefined && subscriber.tree !== tree) continue;
      try {
        subscriber.onEvent(full);
      } catch {
        // A broken listener must not affect the question or other listeners.
      }
    }
  }
}

function detailOf(entry: Entry): QuestionDetail {
  const live = entry.live
    ? {
        attempt: entry.live.attempt,
        answer: entry.live.answer,
        attachments: [...entry.live.attachments],
      }
    : null;
  return { ...entry.info, live };
}

function now(): string {
  return new Date().toISOString();
}
