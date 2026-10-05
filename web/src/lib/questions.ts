/**
 * Client state of in-flight questions (.claude/features/parallel-questions/contracts).
 * PURE: reducer, HTTP-merge rule, lifecycle diff, local remaps, selectors with their equality
 * functions, labels and the in-flight view of a chat panel. Side effects (HTTP, timers,
 * publishing to React) live in `question-store.ts`.
 *
 * Rules worth knowing:
 *  - SSE `question` events always replace the local copy (ordered per connection). HTTP copies
 *    (202 of start/retry) are applied only when the id is unknown or their `attempt` is
 *    higher, and never for removed ids (tombstones): the 202 and the SSE event race.
 *  - `snapshot` is authoritative, except for ids inserted from a 202 that the stream has not
 *    confirmed yet (`unconfirmed`).
 *  - The reducer returns the SAME state object when nothing changed.
 */
import type {
  AttachmentEvent,
  DoneQuestion,
  FailedQuestion,
  QuestionContext,
  QuestionDetail,
  QuestionId,
  QuestionInfo,
  QuestionRemovedReason,
  QuestionStreamEvent,
  RunningQuestionStatus,
  SnapshotEventData,
} from '../api/types';
import { applyAttachmentEvent, type StreamingAttachment } from './attachments';
import type { ComposerFile } from './chat-files';
import { collapseWhitespace, firstLine, truncateGraphemes } from './text';
import { isSameOrDescendant } from './tree';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'paused';

/** Live answer of the current attempt of one question. */
export interface QuestionStream {
  attempt: number;
  text: string;
  attachments: StreamingAttachment[];
}

/** A send of this tab before its 202 (or after a failed upload, shown as "Not sent"). */
export interface OutboxEntry {
  /** Local id `out-<n>`; also the stable graph box key after the 202. */
  id: string;
  tree: string;
  parentId: string;
  context: QuestionContext;
  /** Draft stash key of the sending panel (where the draft goes back on failure). */
  stashKey: string;
  text: string;
  files: ComposerFile[];
  model?: string;
  namingModel?: string;
  phase: 'sending' | 'uploading';
  /** Upload/validation error once the send failed and the sending panel shows it inline. */
  error: unknown | null;
  createdAt: string;
}

export interface QuestionsState {
  /** Server instance of the last snapshot. */
  instance: string | null;
  /** The first snapshot was applied. */
  hydrated: boolean;
  snapshotCount: number;
  connection: ConnectionStatus;
  /** Meta of every question of every tree. */
  questions: Record<QuestionId, QuestionInfo>;
  /** Live text of non-acked questions. */
  streams: Record<QuestionId, QuestionStream>;
  outbox: Record<string, OutboxEntry>;
  /** Question id → outbox id it was sent as (stable box key after the 202). */
  localKeys: Record<QuestionId, string>;
  /** `File`s of questions sent by this tab (thumbnails). */
  localFiles: Record<QuestionId, ComposerFile[]>;
  /** A DELETE of this tab is in flight. */
  cancelling: Record<QuestionId, true>;
  /** Done and the tree refetched (or first seen as done): nothing left to show. */
  acked: Record<QuestionId, true>;
  /** Inserted from a 202 (epoch ms), not yet seen on the stream. */
  unconfirmed: Record<QuestionId, number>;
  /** Last removed ids (newest last): late HTTP copies never bring them back. */
  tombstones: QuestionId[];
}

export const TOMBSTONE_CAP = 500;

export const initialQuestionsState: QuestionsState = {
  instance: null,
  hydrated: false,
  snapshotCount: 0,
  connection: 'idle',
  questions: {},
  streams: {},
  outbox: {},
  localKeys: {},
  localFiles: {},
  cancelling: {},
  acked: {},
  unconfirmed: {},
  tombstones: [],
};

export const MAIN_CONTEXT: QuestionContext = { kind: 'main' };

export const isRunning = (info: QuestionInfo): boolean =>
  info.status === 'streaming' || info.status === 'naming';

export const sameContext = (a: QuestionContext, b: QuestionContext): boolean =>
  a.kind === 'main' ? b.kind === 'main' : b.kind === 'side' && a.anchor === b.anchor;

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/** Server reasons plus the client's own: server restarted / gone while disconnected. */
export type RemovedReason = QuestionRemovedReason | 'restart' | 'missing';

/** `live` = SSE delta, `resync` = derived from a snapshot, `local` = this tab's action. */
export type LifecycleSource = 'live' | 'resync' | 'local';

export type LifecycleEvent =
  | { type: 'added'; question: QuestionInfo; source: LifecycleSource }
  | {
      type: 'accepted';
      question: QuestionInfo;
      outboxId: string;
      entry: OutboxEntry | null;
      source: 'local';
    }
  | { type: 'naming'; question: QuestionInfo; source: LifecycleSource }
  | { type: 'done'; question: DoneQuestion; source: LifecycleSource }
  | { type: 'failed'; question: FailedQuestion; source: LifecycleSource }
  | { type: 'retried'; question: QuestionInfo; source: LifecycleSource }
  | { type: 'moved'; question: QuestionInfo; previous: QuestionInfo; source: LifecycleSource }
  | {
      type: 'removed';
      id: QuestionId;
      tree: string;
      reason: RemovedReason;
      nodeId: string | null;
      question: QuestionInfo | null;
      /** Caused by this tab (its DELETE, or a local remap of its own structural op). */
      local: boolean;
      source: LifecycleSource;
    }
  | {
      type: 'outbox-ended';
      outcome: 'aborted' | 'failed';
      entry: OutboxEntry;
      error: unknown;
      /** The sending panel shows the failure inline. */
      shown: boolean;
      /** The sending panel took the draft and files back. */
      restored: boolean;
      source: 'local';
    };

const contextChanged = (a: QuestionContext, b: QuestionContext) => !sameContext(a, b);

const nodeIdOf = (info: QuestionInfo): string | null =>
  info.status === 'done' ? info.nodeId : null;

function wasMoved(prev: QuestionInfo, next: QuestionInfo): boolean {
  return (
    prev.tree !== next.tree ||
    prev.parentId !== next.parentId ||
    contextChanged(prev.context, next.context) ||
    (prev.status === 'done' && next.status === 'done' && prev.nodeId !== next.nodeId)
  );
}

/** Lifecycle events of replacing `prev` with `next`. */
export function diffQuestion(
  prev: QuestionInfo | undefined,
  next: QuestionInfo,
  source: LifecycleSource,
): LifecycleEvent[] {
  if (!prev) return [{ type: 'added', question: next, source }];
  const events: LifecycleEvent[] = [];
  if (next.attempt > prev.attempt) events.push({ type: 'retried', question: next, source });
  if (next.status !== prev.status || next.attempt !== prev.attempt) {
    if (next.status === 'naming') events.push({ type: 'naming', question: next, source });
    else if (next.status === 'done') events.push({ type: 'done', question: next, source });
    else if (next.status === 'failed') events.push({ type: 'failed', question: next, source });
  }
  if (wasMoved(prev, next)) events.push({ type: 'moved', question: next, previous: prev, source });
  return events;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type QuestionAction =
  | { type: 'event'; event: QuestionStreamEvent }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'outbox/add'; entry: OutboxEntry }
  | { type: 'outbox/accepted'; outboxId: string; question: QuestionInfo }
  | { type: 'outbox/failed'; outboxId: string; error: unknown }
  | { type: 'outbox/drop'; outboxId: string }
  | { type: 'http/question'; question: QuestionInfo }
  | { type: 'cancel/start'; id: QuestionId }
  | { type: 'cancel/end'; id: QuestionId }
  /** After a 204/404 of this tab's DELETE (or retry); idempotent with the SSE `removed`. */
  | { type: 'local/removed'; id: QuestionId; reason: RemovedReason; local?: boolean }
  | { type: 'ack'; id: QuestionId }
  | { type: 'local/remap'; tree: string; map: Record<string, string> }
  | { type: 'local/dropUnder'; tree: string; ids: string[] }
  | { type: 'local/renameTree'; from: string; to: string }
  | { type: 'expireUnconfirmed'; now: number; graceMs: number };

export interface ReduceResult {
  state: QuestionsState;
  lifecycle: LifecycleEvent[];
  /** A chunk gap: reconnect for a fresh snapshot. */
  resync: boolean;
}

const unchanged = (state: QuestionsState): ReduceResult => ({
  state,
  lifecycle: [],
  resync: false,
});

const result = (state: QuestionsState, lifecycle: LifecycleEvent[] = []): ReduceResult => ({
  state,
  lifecycle,
  resync: false,
});

function omit<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!Object.hasOwn(record, id)) return record;
  const { [id]: _removed, ...rest } = record;
  return rest;
}

function addTombstone(list: QuestionId[], id: QuestionId): QuestionId[] {
  if (list.includes(id)) return list;
  const next = [...list, id];
  return next.length > TOMBSTONE_CAP ? next.slice(next.length - TOMBSTONE_CAP) : next;
}

const emptyStream = (attempt: number): QuestionStream => ({ attempt, text: '', attachments: [] });

/** `state` without any trace of `id`, plus a tombstone. */
function without(state: QuestionsState, id: QuestionId): QuestionsState {
  return {
    ...state,
    questions: omit(state.questions, id),
    streams: omit(state.streams, id),
    localKeys: omit(state.localKeys, id),
    localFiles: omit(state.localFiles, id),
    cancelling: omit(state.cancelling, id),
    acked: omit(state.acked, id),
    unconfirmed: omit(state.unconfirmed, id),
    tombstones: addTombstone(state.tombstones, id),
  };
}

function removedEvent(
  id: QuestionId,
  prev: QuestionInfo,
  reason: RemovedReason,
  local: boolean,
  source: LifecycleSource,
  nodeId?: string,
): LifecycleEvent {
  return {
    type: 'removed',
    id,
    tree: prev.tree,
    reason,
    nodeId: nodeId ?? nodeIdOf(prev),
    question: prev,
    local,
    source,
  };
}

/** Remove `id` (any reason). Unknown ids only get a tombstone. */
function removeQuestion(
  state: QuestionsState,
  id: QuestionId,
  reason: RemovedReason,
  options: { local: boolean; source: LifecycleSource; nodeId?: string },
): ReduceResult {
  const prev = state.questions[id];
  if (!prev) {
    const cleaned = without(state, id);
    const same =
      cleaned.tombstones === state.tombstones &&
      cleaned.localKeys === state.localKeys &&
      cleaned.localFiles === state.localFiles &&
      cleaned.cancelling === state.cancelling &&
      cleaned.acked === state.acked &&
      cleaned.unconfirmed === state.unconfirmed &&
      cleaned.streams === state.streams;
    return same ? unchanged(state) : result(cleaned);
  }
  return result(without(state, id), [
    removedEvent(id, prev, reason, options.local, options.source, options.nodeId),
  ]);
}

/** Replace a question with a full copy (SSE or an accepted HTTP copy). */
function replaceQuestion(
  state: QuestionsState,
  question: QuestionInfo,
  source: LifecycleSource,
): ReduceResult {
  if (state.tombstones.includes(question.id)) return unchanged(state);
  const prev = state.questions[question.id];
  const stream = state.streams[question.id];
  const streams =
    stream && question.attempt > stream.attempt
      ? { ...state.streams, [question.id]: emptyStream(question.attempt) }
      : state.streams;
  return result(
    {
      ...state,
      questions: { ...state.questions, [question.id]: question },
      streams,
      unconfirmed: omit(state.unconfirmed, question.id),
    },
    diffQuestion(prev, question, source),
  );
}

/**
 * HTTP-merge rule for 202 copies: insert when unknown (and not removed; it stays
 * `unconfirmed` until the stream shows it), replace only on a higher attempt, else ignore.
 */
function mergeHttp(state: QuestionsState, question: QuestionInfo, now: number): ReduceResult {
  if (state.tombstones.includes(question.id)) return unchanged(state);
  const prev = state.questions[question.id];
  if (!prev)
    return result(
      {
        ...state,
        questions: { ...state.questions, [question.id]: question },
        unconfirmed: { ...state.unconfirmed, [question.id]: now },
      },
      [{ type: 'added', question, source: 'local' }],
    );
  if (question.attempt > prev.attempt) return replaceQuestion(state, question, 'local');
  return unchanged(state);
}

function withoutLive(detail: QuestionDetail): QuestionInfo {
  const { live: _live, ...info } = detail;
  return info as QuestionInfo;
}

function streamOfLive(live: NonNullable<QuestionDetail['live']>): QuestionStream {
  return {
    attempt: live.attempt,
    text: live.answer,
    attachments: live.attachments.reduce<StreamingAttachment[]>(applyAttachmentEvent, []),
  };
}

function reduceSnapshot(state: QuestionsState, data: SnapshotEventData): ReduceResult {
  const restart = state.instance !== null && state.instance !== data.instance;
  const lifecycle: LifecycleEvent[] = [];
  const questions: Record<QuestionId, QuestionInfo> = {};
  const streams: Record<QuestionId, QuestionStream> = {};
  let acked = state.acked;
  let unconfirmed = state.unconfirmed;
  let tombstones = state.tombstones;
  for (const detail of data.questions) {
    const info = withoutLive(detail);
    const { id } = info;
    const prev = state.questions[id];
    questions[id] = info;
    const local = state.streams[id];
    if (detail.live) {
      const fresh = streamOfLive(detail.live);
      const same =
        local !== undefined &&
        local.attempt === fresh.attempt &&
        local.text === fresh.text &&
        JSON.stringify(local.attachments) === JSON.stringify(fresh.attachments);
      streams[id] = same && local ? local : fresh;
    } else if (local && !acked[id]) {
      // Done: the server dropped the text; keep ours for seeding the chain.
      streams[id] = local;
    }
    // Nothing to wait for: the node already exists.
    if (!prev && info.status === 'done' && !acked[id]) acked = { ...acked, [id]: true };
    unconfirmed = omit(unconfirmed, id);
    if (tombstones.includes(id)) tombstones = tombstones.filter((other) => other !== id);
    lifecycle.push(...diffQuestion(prev, info, 'resync'));
  }
  // Inserted from a 202 whose `question` event may still be on the way.
  for (const id of Object.keys(unconfirmed)) {
    const kept = state.questions[id];
    if (!kept || Object.hasOwn(questions, id)) continue;
    questions[id] = kept;
    const stream = state.streams[id];
    if (stream) streams[id] = stream;
  }
  let next: QuestionsState = {
    ...state,
    instance: data.instance,
    hydrated: true,
    snapshotCount: state.snapshotCount + 1,
    questions,
    streams,
    acked,
    unconfirmed,
    tombstones,
  };
  for (const [id, prev] of Object.entries(state.questions)) {
    if (Object.hasOwn(questions, id)) continue;
    lifecycle.push(removedEvent(id, prev, restart ? 'restart' : 'missing', false, 'resync'));
    next = without(next, id);
  }
  return result(next, lifecycle);
}

function withStream(state: QuestionsState, id: QuestionId, stream: QuestionStream) {
  return result({ ...state, streams: { ...state.streams, [id]: stream } });
}

function reduceChunk(
  state: QuestionsState,
  data: { id: QuestionId; attempt: number; offset: number; text: string },
): ReduceResult {
  const { id, attempt, offset, text } = data;
  const info = state.questions[id];
  if (!info || state.acked[id]) return unchanged(state);
  const current = state.streams[id];
  let stream: QuestionStream;
  if (!current) {
    if (attempt < info.attempt) return unchanged(state);
    stream = emptyStream(attempt);
  } else if (attempt < current.attempt) return unchanged(state);
  else stream = attempt > current.attempt ? emptyStream(attempt) : current;
  if (offset > stream.text.length) return { state, lifecycle: [], resync: true };
  // Offsets are UTF-16 code units (contract): this slice is protocol, not display text.
  const tail = text.slice(stream.text.length - offset);
  if (!tail) return stream === current ? unchanged(state) : withStream(state, id, stream);
  return withStream(state, id, { ...stream, text: stream.text + tail });
}

function reduceAttachment(
  state: QuestionsState,
  data: { id: QuestionId; attempt: number; event: AttachmentEvent },
): ReduceResult {
  const { id, attempt, event } = data;
  const info = state.questions[id];
  if (!info || state.acked[id]) return unchanged(state);
  const current = state.streams[id];
  let stream: QuestionStream;
  if (current && current.attempt === attempt) stream = current;
  else if (attempt === info.attempt && (!current || current.attempt < attempt))
    stream = emptyStream(attempt);
  else return unchanged(state);
  return withStream(state, id, {
    ...stream,
    attachments: applyAttachmentEvent(stream.attachments, event),
  });
}

function reduceEvent(state: QuestionsState, event: QuestionStreamEvent): ReduceResult {
  switch (event.event) {
    case 'snapshot':
      return reduceSnapshot(state, event.data);
    case 'question':
      return replaceQuestion(state, event.data.question, 'live');
    case 'chunk':
      return reduceChunk(state, event.data);
    case 'attachment':
      return reduceAttachment(state, event.data);
    case 'removed': {
      const { id, reason, nodeId } = event.data;
      return removeQuestion(state, id, reason, {
        local: Boolean(state.cancelling[id]),
        source: 'live',
        nodeId,
      });
    }
    default:
      return unchanged(state);
  }
}

/** Prefix rewrite (`x === old` or inside it), longest old id first; `''`/identity ignored. */
function remapperOf(map: Record<string, string>): ((id: string) => string) | null {
  const pairs = Object.entries(map)
    .filter(([from, to]) => from !== '' && from !== to)
    .sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return null;
  return (id) => {
    for (const [from, to] of pairs) {
      if (id === from || id.startsWith(`${from}/`)) return to + id.slice(from.length);
    }
    return id;
  };
}

/** Mirror of the server's remap of retained (failed/done) entries after a move/rename. */
function localRemap(
  state: QuestionsState,
  tree: string,
  map: Record<string, string>,
): ReduceResult {
  const remap = remapperOf(map);
  if (!remap) return unchanged(state);
  const lifecycle: LifecycleEvent[] = [];
  let questions = state.questions;
  for (const info of Object.values(state.questions)) {
    if (info.tree !== tree || isRunning(info)) continue;
    const parentId = remap(info.parentId);
    let context = info.context;
    if (context.kind === 'side') {
      let anchor = remap(context.anchor);
      if (!isSameOrDescendant(parentId, anchor)) anchor = parentId;
      if (anchor !== context.anchor) context = { kind: 'side', anchor };
    }
    const nodeId = info.status === 'done' ? remap(info.nodeId) : null;
    const nodeChanged = info.status === 'done' && nodeId !== info.nodeId;
    if (parentId === info.parentId && context === info.context && !nodeChanged) continue;
    const next: QuestionInfo =
      info.status === 'done'
        ? { ...info, parentId, context, nodeId: nodeId ?? info.nodeId }
        : { ...info, parentId, context };
    questions = { ...questions, [info.id]: next };
    lifecycle.push({ type: 'moved', question: next, previous: info, source: 'local' });
  }
  return questions === state.questions
    ? unchanged(state)
    : result({ ...state, questions }, lifecycle);
}

/** Mirror of the server's removal of retained entries under deleted nodes. */
function localDropUnder(state: QuestionsState, tree: string, ids: string[]): ReduceResult {
  const roots = ids.filter((id) => id !== '');
  const inside = (id: string) => roots.some((root) => isSameOrDescendant(id, root));
  let next = state;
  const lifecycle: LifecycleEvent[] = [];
  for (const info of Object.values(state.questions)) {
    if (info.tree !== tree || isRunning(info)) continue;
    const doneInside = info.status === 'done' && inside(info.nodeId);
    if (!inside(info.parentId) && !doneInside) continue;
    const removed = removeQuestion(next, info.id, 'deleted', { local: true, source: 'local' });
    next = removed.state;
    lifecycle.push(...removed.lifecycle);
  }
  return next === state ? unchanged(state) : result(next, lifecycle);
}

function localRenameTree(state: QuestionsState, from: string, to: string): ReduceResult {
  if (from === to) return unchanged(state);
  let questions = state.questions;
  const lifecycle: LifecycleEvent[] = [];
  for (const info of Object.values(state.questions)) {
    if (info.tree !== from) continue;
    const next = { ...info, tree: to };
    questions = { ...questions, [info.id]: next };
    lifecycle.push({ type: 'moved', question: next, previous: info, source: 'local' });
  }
  return questions === state.questions
    ? unchanged(state)
    : result({ ...state, questions }, lifecycle);
}

/** Pure transition. `now` (epoch ms) stamps `unconfirmed` entries. */
export function reduce(state: QuestionsState, action: QuestionAction, now: number): ReduceResult {
  switch (action.type) {
    case 'event':
      return reduceEvent(state, action.event);
    case 'connection':
      return action.status === state.connection
        ? unchanged(state)
        : result({ ...state, connection: action.status });
    case 'outbox/add':
      return result({ ...state, outbox: { ...state.outbox, [action.entry.id]: action.entry } });
    case 'outbox/accepted': {
      const { outboxId, question } = action;
      const entry = state.outbox[outboxId] ?? null;
      let next: QuestionsState = { ...state, outbox: omit(state.outbox, outboxId) };
      if (!state.tombstones.includes(question.id)) {
        next.localKeys = { ...next.localKeys, [question.id]: outboxId };
        if (entry && entry.files.length > 0)
          next.localFiles = { ...next.localFiles, [question.id]: entry.files };
      }
      const merged = mergeHttp(next, question, now);
      next = merged.state;
      return result(next, [
        ...merged.lifecycle,
        {
          type: 'accepted',
          question: next.questions[question.id] ?? question,
          outboxId,
          entry,
          source: 'local',
        },
      ]);
    }
    case 'outbox/failed': {
      const entry = state.outbox[action.outboxId];
      if (!entry) return unchanged(state);
      return result({
        ...state,
        outbox: { ...state.outbox, [entry.id]: { ...entry, error: action.error } },
      });
    }
    case 'outbox/drop':
      return Object.hasOwn(state.outbox, action.outboxId)
        ? result({ ...state, outbox: omit(state.outbox, action.outboxId) })
        : unchanged(state);
    case 'http/question':
      return mergeHttp(state, action.question, now);
    case 'cancel/start':
      return state.cancelling[action.id]
        ? unchanged(state)
        : result({ ...state, cancelling: { ...state.cancelling, [action.id]: true } });
    case 'cancel/end':
      return state.cancelling[action.id]
        ? result({ ...state, cancelling: omit(state.cancelling, action.id) })
        : unchanged(state);
    case 'local/removed':
      return removeQuestion(state, action.id, action.reason, {
        local: action.local ?? true,
        source: 'local',
      });
    case 'ack': {
      const { id } = action;
      if (!state.questions[id] || state.acked[id]) return unchanged(state);
      return result({
        ...state,
        acked: { ...state.acked, [id]: true },
        streams: omit(state.streams, id),
        localFiles: omit(state.localFiles, id),
      });
    }
    case 'local/remap':
      return localRemap(state, action.tree, action.map);
    case 'local/dropUnder':
      return localDropUnder(state, action.tree, action.ids);
    case 'local/renameTree':
      return localRenameTree(state, action.from, action.to);
    case 'expireUnconfirmed': {
      let next = state;
      const lifecycle: LifecycleEvent[] = [];
      for (const [id, since] of Object.entries(state.unconfirmed)) {
        if (action.now - since <= action.graceMs) continue;
        const removed = removeQuestion(next, id, 'missing', { local: false, source: 'resync' });
        next = removed.state;
        lifecycle.push(...removed.lifecycle);
      }
      return next === state ? unchanged(state) : result(next, lifecycle);
    }
    default:
      return unchanged(state);
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const PENDING_LABEL_GRAPHEMES = 40;
export const PENDING_TOOLTIP_GRAPHEMES = 200;
/** Same cut as the server's `QuestionInfo.title`. */
export const QUESTION_TITLE_MAX_GRAPHEMES = 80;

/** One-line label of a pending box: the (server) title cut again for the box. */
export const pendingLabel = (title: string, max = PENDING_LABEL_GRAPHEMES): string =>
  truncateGraphemes(collapseWhitespace(title), max);

/** Tooltip text of a pending box: the question (or file names), ≤ 200 graphemes. */
export const pendingTooltip = (text: string, fileNames: readonly string[]): string =>
  truncateGraphemes(text.trim() || fileNames.join(', '), PENDING_TOOLTIP_GRAPHEMES);

/** Client mirror of the server title, for sends that have no server copy yet. */
export const questionTitle = (text: string, fileNames: readonly string[]): string =>
  truncateGraphemes(
    collapseWhitespace(firstLine(text)) || fileNames.join(', '),
    QUESTION_TITLE_MAX_GRAPHEMES,
  );

const outboxFileNames = (entry: OutboxEntry) => entry.files.map((item) => item.file.name);

// ---------------------------------------------------------------------------
// Selectors (pure; each with the equality its hook cache uses)
// ---------------------------------------------------------------------------

const byCreated = (
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}

/** Meta of `tree`'s questions, by `createdAt`. Chunks never change it. */
export function selectTreeQuestions(state: QuestionsState, tree: string): QuestionInfo[] {
  return Object.values(state.questions)
    .filter((info) => info.tree === tree)
    .sort(byCreated);
}

export const treeQuestionsEqual = shallowArrayEqual<QuestionInfo>;

/** A box in the graph for a running, failed or not-yet-acked question, or a live send. */
export interface PendingBox {
  /** Stable flow key: the outbox id for sends of this tab (kept across the 202), else the id. */
  key: string;
  questionId: QuestionId | null;
  outboxId: string | null;
  parentId: string;
  context: QuestionContext;
  label: string;
  createdAt: string;
  /** Done: the created node (the box stays until the refetched tree shows it). */
  nodeId: string | null;
}

export function selectPendingBoxes(state: QuestionsState, tree: string): PendingBox[] {
  const boxes: PendingBox[] = [];
  for (const info of Object.values(state.questions)) {
    if (info.tree !== tree) continue;
    if (info.status === 'done' && state.acked[info.id]) continue;
    boxes.push({
      key: state.localKeys[info.id] ?? info.id,
      questionId: info.id,
      outboxId: null,
      parentId: info.parentId,
      context: info.context,
      label: pendingLabel(info.title),
      createdAt: info.createdAt,
      nodeId: nodeIdOf(info),
    });
  }
  for (const entry of Object.values(state.outbox)) {
    if (entry.tree !== tree || entry.error !== null) continue;
    boxes.push({
      key: entry.id,
      questionId: null,
      outboxId: entry.id,
      parentId: entry.parentId,
      context: entry.context,
      label: pendingLabel(questionTitle(entry.text, outboxFileNames(entry))),
      createdAt: entry.createdAt,
      nodeId: null,
    });
  }
  return boxes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}

const boxEqual = (a: PendingBox, b: PendingBox) =>
  a.key === b.key &&
  a.questionId === b.questionId &&
  a.outboxId === b.outboxId &&
  a.parentId === b.parentId &&
  sameContext(a.context, b.context) &&
  a.label === b.label &&
  a.nodeId === b.nodeId;

/** Same boxes: chunks and status changes never change the layout input. */
export const pendingBoxesEqual = (a: readonly PendingBox[], b: readonly PendingBox[]): boolean =>
  a.length === b.length && a.every((box, index) => boxEqual(box, b[index] as PendingBox));

export type PendingStatus =
  | 'sending'
  | 'uploading'
  | 'streaming'
  | 'naming'
  | 'done'
  | 'failed'
  | 'cancelling';

export interface PendingStatusInfo {
  questionId: QuestionId | null;
  outboxId: string | null;
  status: PendingStatus;
  /** Question text (≤ 200 graphemes); the view adds the localized status. */
  tooltip: string;
  /** Failure message of a failed question. */
  error?: string;
}

export function selectPendingStatuses(
  state: QuestionsState,
  tree: string,
): Record<string, PendingStatusInfo> {
  const statuses: Record<string, PendingStatusInfo> = {};
  for (const info of Object.values(state.questions)) {
    if (info.tree !== tree) continue;
    if (info.status === 'done' && state.acked[info.id]) continue;
    const key = state.localKeys[info.id] ?? info.id;
    statuses[key] = {
      questionId: info.id,
      outboxId: null,
      status: state.cancelling[info.id] ? 'cancelling' : info.status,
      tooltip: pendingTooltip(
        info.text,
        info.files.map((file) => file.name),
      ),
      ...(info.status === 'failed' ? { error: info.error.message } : {}),
    };
  }
  for (const entry of Object.values(state.outbox)) {
    if (entry.tree !== tree || entry.error !== null) continue;
    statuses[entry.id] = {
      questionId: null,
      outboxId: entry.id,
      status: entry.phase,
      tooltip: pendingTooltip(entry.text, outboxFileNames(entry)),
    };
  }
  return statuses;
}

const statusEqual = (a: PendingStatusInfo, b: PendingStatusInfo) =>
  a.questionId === b.questionId &&
  a.outboxId === b.outboxId &&
  a.status === b.status &&
  a.tooltip === b.tooltip &&
  a.error === b.error;

export function pendingStatusesEqual(
  a: Record<string, PendingStatusInfo>,
  b: Record<string, PendingStatusInfo>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const other = b[key];
    const own = a[key];
    return own !== undefined && other !== undefined && statusEqual(own, other);
  });
}

/** Something holds (or is about to hold) the tree's shared lock. */
export function selectIsTreeBusy(state: QuestionsState, tree: string): boolean {
  return (
    Object.values(state.questions).some((info) => info.tree === tree && isRunning(info)) ||
    Object.values(state.outbox).some((entry) => entry.tree === tree && entry.error === null)
  );
}

export interface TreeCounts {
  /** Running answers plus live sends. */
  running: number;
  failed: number;
}

export function selectTreeCounts(state: QuestionsState): Record<string, TreeCounts> {
  const counts: Record<string, TreeCounts> = {};
  const of = (tree: string) => {
    const existing = counts[tree];
    if (existing) return existing;
    const created = { running: 0, failed: 0 };
    counts[tree] = created;
    return created;
  };
  for (const info of Object.values(state.questions)) {
    if (isRunning(info)) of(info.tree).running += 1;
    else if (info.status === 'failed') of(info.tree).failed += 1;
  }
  for (const entry of Object.values(state.outbox)) {
    if (entry.error === null) of(entry.tree).running += 1;
  }
  return counts;
}

export function treeCountsEqual(
  a: Record<string, TreeCounts>,
  b: Record<string, TreeCounts>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => a[key]?.running === b[key]?.running && a[key]?.failed === b[key]?.failed,
  );
}

/** Everything one panel needs to show a focused question. */
export interface QuestionView {
  info: QuestionInfo;
  stream: QuestionStream | null;
  localFiles: ComposerFile[] | null;
  cancelling: boolean;
  acked: boolean;
}

export function selectQuestionView(state: QuestionsState, id: QuestionId): QuestionView | null {
  const info = state.questions[id];
  if (!info) return null;
  return {
    info,
    stream: state.streams[id] ?? null,
    localFiles: state.localFiles[id] ?? null,
    cancelling: Boolean(state.cancelling[id]),
    acked: Boolean(state.acked[id]),
  };
}

export function questionViewEqual(a: QuestionView | null, b: QuestionView | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.info === b.info &&
    a.stream === b.stream &&
    a.localFiles === b.localFiles &&
    a.cancelling === b.cancelling &&
    a.acked === b.acked
  );
}

/** Newest send of `tree` under `parentId` in `context` (errored ones included). */
export function selectOutboxFor(
  state: QuestionsState,
  tree: string,
  context: QuestionContext,
  parentId: string,
): OutboxEntry | null {
  let newest: OutboxEntry | null = null;
  for (const entry of Object.values(state.outbox)) {
    if (entry.tree !== tree || entry.parentId !== parentId || !sameContext(entry.context, context))
      continue;
    if (!newest || entry.createdAt >= newest.createdAt) newest = entry;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// In-flight view of a chat panel
// ---------------------------------------------------------------------------

export type InFlightView =
  | { kind: 'outbox'; entry: OutboxEntry }
  | {
      kind: 'question';
      info: QuestionInfo;
      stream: QuestionStream | null;
      localFiles: ComposerFile[] | null;
      cancelling: boolean;
    }
  /** A focused id from the URL before the first snapshot. */
  | { kind: 'loading'; id: QuestionId };

export type InFlightStatus =
  | 'sending'
  | 'uploading'
  | 'answering'
  | 'saving'
  | 'cancelling'
  | 'failed'
  | 'not-sent'
  | 'loading';

export function inFlightStatus(view: InFlightView): InFlightStatus {
  switch (view.kind) {
    case 'outbox':
      return view.entry.error !== null ? 'not-sent' : view.entry.phase;
    case 'loading':
      return 'loading';
    case 'question': {
      if (view.cancelling) return 'cancelling';
      const status = view.info.status;
      if (status === 'streaming') return 'answering';
      if (status === 'failed') return 'failed';
      return 'saving';
    }
    default:
      return 'loading';
  }
}

/** Cancel is offered for live sends and streaming answers (never while saving). */
export function inFlightCanCancel(view: InFlightView): boolean {
  if (view.kind === 'outbox') return view.entry.error === null;
  if (view.kind === 'question') return view.info.status === 'streaming' && !view.cancelling;
  return false;
}

export const isRunningStatus = (status: string): status is RunningQuestionStatus =>
  status === 'streaming' || status === 'naming';

// ---------------------------------------------------------------------------
// Cached selectors
// ---------------------------------------------------------------------------

/**
 * Memoize `select`: the same state object returns the same value, and a new value equal to
 * the previous one (by `equal`) returns the previous reference. Required for
 * `useSyncExternalStore`, which re-renders (or loops) on every new reference.
 */
export function createCachedSelector<S, T>(
  select: (state: S) => T,
  equal: (a: T, b: T) => boolean,
): (state: S) => T {
  let has = false;
  let lastState: S | undefined;
  let lastValue: T | undefined;
  return (state) => {
    if (has && state === lastState) return lastValue as T;
    const next = select(state);
    lastState = state;
    if (has && equal(lastValue as T, next)) return lastValue as T;
    has = true;
    lastValue = next;
    return next;
  };
}
