import { describe, expect, it } from 'vitest';
import type {
  DoneQuestion,
  FailedQuestion,
  QuestionDetail,
  QuestionInfo,
  QuestionStreamEvent,
  RunningQuestion,
} from '../api/types';
import type { ComposerFile } from './chat-files';
import {
  createCachedSelector,
  inFlightCanCancel,
  inFlightStatus,
  initialQuestionsState,
  type LifecycleEvent,
  type OutboxEntry,
  pendingBoxesEqual,
  pendingLabel,
  pendingStatusesEqual,
  pendingTooltip,
  type QuestionAction,
  type QuestionsState,
  questionTitle,
  reduce,
  selectIsTreeBusy,
  selectOutboxFor,
  selectPendingBoxes,
  selectPendingStatuses,
  selectQuestionView,
  selectTreeCounts,
  selectTreeQuestions,
  TOMBSTONE_CAP,
  treeQuestionsEqual,
} from './questions';

const T0 = '2026-10-04T10:00:00.000Z';
const T1 = '2026-10-04T10:00:01.000Z';
const T2 = '2026-10-04T10:00:02.000Z';
const NOW = 1_000_000;

const running = (id: string, overrides: Partial<RunningQuestion> = {}): RunningQuestion => ({
  id,
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  text: `Question ${id}`,
  title: `Question ${id}`,
  files: [],
  model: 'm',
  namingModel: 'n',
  attempt: 1,
  status: 'streaming',
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const done = (id: string, overrides: Partial<DoneQuestion> = {}): DoneQuestion => {
  const { status: _status, ...base } = running(id);
  return { ...base, status: 'done', nodeId: `основы/${id}`, attachments: [], ...overrides };
};

const failed = (id: string, overrides: Partial<FailedQuestion> = {}): FailedQuestion => {
  const { status: _status, ...base } = running(id);
  return {
    ...base,
    status: 'failed',
    error: { code: 'agent_error', message: 'boom' },
    ...overrides,
  };
};

const detail = (info: QuestionInfo, answer = ''): QuestionDetail => ({
  ...info,
  live: info.status === 'done' ? null : { attempt: info.attempt, answer, attachments: [] },
});

const ev = {
  snapshot: (questions: QuestionDetail[], instance = 'i1'): QuestionStreamEvent => ({
    event: 'snapshot',
    data: { instance, questions },
  }),
  question: (question: QuestionInfo): QuestionStreamEvent => ({
    event: 'question',
    data: { question },
  }),
  chunk: (id: string, offset: number, text: string, attempt = 1): QuestionStreamEvent => ({
    event: 'chunk',
    data: { id, tree: 't', attempt, offset, text },
  }),
  removed: (
    id: string,
    reason: 'cancelled' | 'dismissed' | 'expired' | 'deleted' = 'cancelled',
  ): QuestionStreamEvent => ({ event: 'removed', data: { id, tree: 't', reason } }),
};

/** Apply actions in order; collects every lifecycle event. */
function run(state: QuestionsState, ...actions: QuestionAction[]) {
  let current = state;
  const lifecycle: LifecycleEvent[] = [];
  let resync = false;
  for (const action of actions) {
    const result = reduce(current, action, NOW);
    current = result.state;
    lifecycle.push(...result.lifecycle);
    resync ||= result.resync;
  }
  return { state: current, lifecycle, resync };
}

const event = (e: QuestionStreamEvent): QuestionAction => ({ type: 'event', event: e });

const hydrated = (...questions: QuestionDetail[]) =>
  run(initialQuestionsState, event(ev.snapshot(questions))).state;

let fileId = 1;
const composerFile = (name: string): ComposerFile => ({
  id: fileId++,
  file: new File(['x'], name),
});

const outbox = (id: string, overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id,
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  stashKey: 't:main',
  text: 'Отправка вопроса',
  files: [],
  phase: 'sending',
  error: null,
  createdAt: T1,
  ...overrides,
});

describe('snapshot', () => {
  it('hydrates, sets streams from live state and counts snapshots', () => {
    const state = hydrated(detail(running('a'), 'Hello'), detail(done('b')));
    expect(state.hydrated).toBe(true);
    expect(state.instance).toBe('i1');
    expect(state.snapshotCount).toBe(1);
    expect(state.streams.a).toEqual({ attempt: 1, text: 'Hello', attachments: [] });
    expect(state.streams.b).toBeUndefined();
    // First seen as done: nothing to wait for.
    expect(state.acked.b).toBe(true);
    expect(state.acked.a).toBeUndefined();
  });

  it('reduces live attachments in order', () => {
    const info = running('a');
    const state = hydrated({
      ...info,
      live: {
        attempt: 1,
        answer: '',
        attachments: [
          { status: 'saving', key: 'k1', requestedName: 'x.svg', origin: 'inline' },
          { status: 'failed', key: 'k2', requestedName: 'y.csv', message: 'nope' },
        ],
      },
    });
    expect(state.streams.a?.attachments.map((item) => [item.key, item.status])).toEqual([
      ['k1', 'saving'],
      ['k2', 'failed'],
    ]);
  });

  it('removes missing entries as missing (same instance) or restart (new instance)', () => {
    const state = hydrated(detail(running('a')), detail(running('b')));
    const missing = run(state, event(ev.snapshot([detail(running('a'))])));
    expect(Object.keys(missing.state.questions)).toEqual(['a']);
    expect(missing.state.tombstones).toEqual(['b']);
    expect(missing.lifecycle).toContainEqual(
      expect.objectContaining({ type: 'removed', id: 'b', reason: 'missing', source: 'resync' }),
    );
    const restart = run(state, event(ev.snapshot([], 'i2')));
    expect(restart.state.questions).toEqual({});
    expect(restart.state.instance).toBe('i2');
    expect(
      restart.lifecycle.filter((item) => item.type === 'removed').map((item) => item.reason),
    ).toEqual(['restart', 'restart']);
  });

  it('keeps the local stream of a question that finished while disconnected', () => {
    let state = hydrated(detail(running('a'), 'Partial'));
    state = run(state, event(ev.chunk('a', 7, ' answer'))).state;
    const next = run(state, event(ev.snapshot([detail(done('a'))])));
    expect(next.state.streams.a?.text).toBe('Partial answer');
    expect(next.state.acked.a).toBeUndefined();
    expect(next.lifecycle).toContainEqual(
      expect.objectContaining({ type: 'done', source: 'resync' }),
    );
  });

  it('keeps unconfirmed 202 copies the snapshot does not list yet', () => {
    let state = hydrated();
    state = run(state, { type: 'http/question', question: running('a') }).state;
    expect(state.unconfirmed.a).toBe(NOW);
    const next = run(state, event(ev.snapshot([]))).state;
    expect(next.questions.a).toBeDefined();
    // Listed later: confirmed.
    const listed = run(next, event(ev.snapshot([detail(running('a'))]))).state;
    expect(listed.unconfirmed.a).toBeUndefined();
  });

  it('keeps the same stream object when the live state did not change', () => {
    const state = hydrated(detail(running('a'), 'Same'));
    const next = run(state, event(ev.snapshot([detail(running('a'), 'Same')]))).state;
    expect(next.streams.a).toBe(state.streams.a);
  });
});

describe('question events and the HTTP merge rule', () => {
  it('adds, then reports naming, done and failed transitions', () => {
    const state = hydrated();
    const result = run(
      state,
      event(ev.question(running('a'))),
      event(ev.question(running('a', { status: 'naming' }))),
      event(ev.question(done('a'))),
    );
    expect(result.lifecycle.map((item) => item.type)).toEqual(['added', 'naming', 'done']);
    expect(result.lifecycle.every((item) => item.source === 'live')).toBe(true);
  });

  it('never regresses when the SSE copy arrives before the 202', () => {
    let state = hydrated();
    state = run(state, event(ev.question(running('a'))), event(ev.question(done('a')))).state;
    const after = run(state, { type: 'http/question', question: running('a') });
    expect(after.state).toBe(state);
    expect(after.state.questions.a?.status).toBe('done');
  });

  it('inserts a 202 copy first and lets the SSE copy replace it', () => {
    let state = hydrated();
    state = run(state, { type: 'http/question', question: running('a') }).state;
    expect(state.questions.a?.status).toBe('streaming');
    state = run(state, event(ev.question(running('a', { status: 'naming' })))).state;
    expect(state.questions.a?.status).toBe('naming');
    expect(state.unconfirmed.a).toBeUndefined();
  });

  it('applies a retry 202 only when its attempt is higher', () => {
    let state = hydrated(detail(failed('a'), 'partial'));
    const retried = running('a', { attempt: 2 });
    const result = run(state, { type: 'http/question', question: retried });
    state = result.state;
    expect(state.questions.a).toBe(retried);
    expect(state.streams.a).toEqual({ attempt: 2, text: '', attachments: [] });
    expect(result.lifecycle.map((item) => item.type)).toEqual(['retried']);
    // The stream already reported the failure of attempt 2: the 202 copy is older.
    state = run(state, event(ev.question(failed('a', { attempt: 2 })))).state;
    expect(run(state, { type: 'http/question', question: retried }).state).toBe(state);
  });

  it('ignores tombstoned ids from HTTP and SSE', () => {
    let state = hydrated(detail(running('a')));
    state = run(state, event(ev.removed('a'))).state;
    expect(run(state, { type: 'http/question', question: running('a') }).state).toBe(state);
    expect(run(state, event(ev.question(running('a')))).state).toBe(state);
  });

  it('reports moves of parent, context, tree and node', () => {
    const state = hydrated(detail(done('a')));
    const result = run(
      state,
      event(ev.question(done('a', { parentId: 'x/основы', nodeId: 'x/основы/a' }))),
    );
    expect(result.lifecycle).toEqual([
      expect.objectContaining({ type: 'moved', previous: state.questions.a }),
    ]);
  });
});

describe('chunks', () => {
  const base = () => hydrated(detail(running('a'), 'Hello'));

  it('appends and dedupes overlaps', () => {
    let state = run(base(), event(ev.chunk('a', 5, ' world'))).state;
    expect(state.streams.a?.text).toBe('Hello world');
    state = run(state, event(ev.chunk('a', 8, 'rld!'))).state;
    expect(state.streams.a?.text).toBe('Hello world!');
  });

  it('returns the same state for an exact duplicate', () => {
    const state = base();
    expect(run(state, event(ev.chunk('a', 0, 'Hello'))).state).toBe(state);
  });

  it('signals a gap and leaves the state unchanged', () => {
    const state = base();
    const result = run(state, event(ev.chunk('a', 9, 'late')));
    expect(result.resync).toBe(true);
    expect(result.state).toBe(state);
  });

  it('drops stale attempts and resets on a newer one', () => {
    let state = hydrated(detail(running('a', { attempt: 2 }), 'Two'));
    expect(run(state, event(ev.chunk('a', 0, 'old', 1))).state).toBe(state);
    state = run(state, event(ev.chunk('a', 0, 'Three', 3))).state;
    expect(state.streams.a).toEqual({ attempt: 3, text: 'Three', attachments: [] });
  });

  it('drops chunks of unknown ids', () => {
    const state = base();
    expect(run(state, event(ev.chunk('zzz', 0, 'x'))).state).toBe(state);
  });
});

describe('attachments', () => {
  it('applies events of the current attempt only', () => {
    let state = hydrated(detail(running('a', { attempt: 2 })));
    const saving = { status: 'saving' as const, key: 'k', origin: 'inline' as const };
    const stale = reduce(
      state,
      event({ event: 'attachment', data: { id: 'a', tree: 't', attempt: 1, event: saving } }),
      NOW,
    );
    expect(stale.state).toBe(state);
    state = reduce(
      state,
      event({ event: 'attachment', data: { id: 'a', tree: 't', attempt: 2, event: saving } }),
      NOW,
    ).state;
    expect(state.streams.a?.attachments).toEqual([
      { key: 'k', status: 'saving', origin: 'inline', requestedName: undefined },
    ]);
  });
});

describe('removed', () => {
  it('cleans every map, adds a tombstone and reports whether this tab cancelled', () => {
    let state = hydrated(detail(running('a'), 'x'));
    state = run(
      state,
      { type: 'outbox/add', entry: outbox('out-1', { files: [composerFile('a.pdf')] }) },
      { type: 'outbox/accepted', outboxId: 'out-1', question: running('a') },
      { type: 'cancel/start', id: 'a' },
    ).state;
    expect(state.localKeys.a).toBe('out-1');
    const result = run(state, event(ev.removed('a', 'cancelled')));
    const next = result.state;
    for (const map of [
      next.questions,
      next.streams,
      next.localKeys,
      next.localFiles,
      next.cancelling,
      next.acked,
      next.unconfirmed,
    ])
      expect(map).not.toHaveProperty('a');
    expect(next.tombstones).toEqual(['a']);
    expect(result.lifecycle).toEqual([
      expect.objectContaining({
        type: 'removed',
        reason: 'cancelled',
        local: true,
        source: 'live',
      }),
    ]);
  });

  it('carries the node of a done entry', () => {
    const state = hydrated(detail(done('a')));
    const result = run(state, event(ev.removed('a', 'expired')));
    expect(result.lifecycle).toEqual([
      expect.objectContaining({ reason: 'expired', nodeId: 'основы/a', local: false }),
    ]);
  });

  it('caps the tombstones', () => {
    let state = hydrated();
    for (let index = 0; index < TOMBSTONE_CAP + 5; index += 1)
      state = run(state, event(ev.removed(`q${index}`))).state;
    expect(state.tombstones).toHaveLength(TOMBSTONE_CAP);
    expect(state.tombstones[0]).toBe('q5');
  });

  it('is idempotent with a local removal', () => {
    let state = hydrated(detail(running('a')));
    state = run(state, { type: 'local/removed', id: 'a', reason: 'cancelled' }).state;
    expect(run(state, event(ev.removed('a'))).state).toBe(state);
    expect(run(state, { type: 'local/removed', id: 'a', reason: 'cancelled' }).state).toBe(state);
  });
});

describe('outbox', () => {
  it('moves files and the box key to the accepted question', () => {
    const files = [composerFile('a.png')];
    let state = hydrated();
    state = run(state, {
      type: 'outbox/add',
      entry: outbox('out-1', { files, phase: 'uploading' }),
    }).state;
    expect(selectPendingBoxes(state, 't').map((box) => box.key)).toEqual(['out-1']);
    const result = run(state, {
      type: 'outbox/accepted',
      outboxId: 'out-1',
      question: running('a'),
    });
    state = result.state;
    expect(state.outbox).toEqual({});
    expect(state.localFiles.a).toBe(files);
    expect(state.localKeys.a).toBe('out-1');
    expect(state.unconfirmed.a).toBe(NOW);
    expect(result.lifecycle.map((item) => item.type)).toEqual(['added', 'accepted']);
    expect(selectPendingBoxes(state, 't').map((box) => [box.key, box.questionId])).toEqual([
      ['out-1', 'a'],
    ]);
  });

  it('keeps a failed send with its error, and drops it', () => {
    let state = run(hydrated(), { type: 'outbox/add', entry: outbox('out-1') }).state;
    state = run(state, { type: 'outbox/failed', outboxId: 'out-1', error: new Error('x') }).state;
    expect(state.outbox['out-1']?.error).toBeInstanceOf(Error);
    // A "Not sent" entry is no box and does not keep the tree busy.
    expect(selectPendingBoxes(state, 't')).toEqual([]);
    expect(selectIsTreeBusy(state, 't')).toBe(false);
    state = run(state, { type: 'outbox/drop', outboxId: 'out-1' }).state;
    expect(state.outbox).toEqual({});
  });

  it('finds the newest send of a target', () => {
    const state = run(
      hydrated(),
      { type: 'outbox/add', entry: outbox('out-1') },
      { type: 'outbox/add', entry: outbox('out-2', { createdAt: T2 }) },
      { type: 'outbox/add', entry: outbox('out-3', { context: { kind: 'side', anchor: '' } }) },
    ).state;
    expect(selectOutboxFor(state, 't', { kind: 'main' }, 'основы')?.id).toBe('out-2');
    expect(selectOutboxFor(state, 't', { kind: 'side', anchor: '' }, 'основы')?.id).toBe('out-3');
    expect(selectOutboxFor(state, 't', { kind: 'side', anchor: 'x' }, 'основы')).toBeNull();
  });
});

describe('cancel and ack', () => {
  it('marks and unmarks a cancel in flight', () => {
    let state = hydrated(detail(running('a')));
    state = run(state, { type: 'cancel/start', id: 'a' }).state;
    expect(selectPendingStatuses(state, 't').a?.status).toBe('cancelling');
    state = run(state, { type: 'cancel/end', id: 'a' }).state;
    expect(state.cancelling).toEqual({});
  });

  it('ack drops the stream and local files and hides the box', () => {
    let state = hydrated(detail(running('a'), 'text'));
    state = run(
      state,
      { type: 'outbox/add', entry: outbox('out-1', { files: [composerFile('b.pdf')] }) },
      { type: 'outbox/accepted', outboxId: 'out-1', question: running('a') },
      event(ev.question(done('a'))),
    ).state;
    expect(selectPendingBoxes(state, 't')).toHaveLength(1);
    state = run(state, { type: 'ack', id: 'a' }).state;
    expect(state.acked.a).toBe(true);
    expect(state.streams.a).toBeUndefined();
    expect(state.localFiles.a).toBeUndefined();
    expect(selectPendingBoxes(state, 't')).toEqual([]);
    expect(run(state, { type: 'ack', id: 'a' }).state).toBe(state);
  });
});

describe('local mirrors of structural ops', () => {
  const side = (anchor: string) => ({ kind: 'side' as const, anchor });

  it('remaps retained entries by prefix and leaves running ones alone', () => {
    const state = hydrated(
      detail(failed('f', { parentId: 'основы/правила', context: side('основы') })),
      detail(done('d', { parentId: 'основы', nodeId: 'основы/d' })),
      detail(running('r', { parentId: 'основы' })),
      detail(failed('g', { parentId: 'основы-2' })),
    );
    const result = run(state, { type: 'local/remap', tree: 't', map: { основы: 'x/основы' } });
    const next = result.state;
    expect(next.questions.f?.parentId).toBe('x/основы/правила');
    expect(next.questions.f?.context).toEqual(side('x/основы'));
    expect((next.questions.d as DoneQuestion).nodeId).toBe('x/основы/d');
    expect(next.questions.r).toBe(state.questions.r);
    // `основы` must not touch `основы-2`.
    expect(next.questions.g).toBe(state.questions.g);
    expect(result.lifecycle.map((item) => item.type)).toEqual(['moved', 'moved']);
    expect(result.lifecycle.every((item) => item.source === 'local')).toBe(true);
  });

  it('fixes a side anchor that is no longer an ancestor', () => {
    const state = hydrated(detail(failed('f', { parentId: 'a/b', context: side('a') })));
    const next = run(state, { type: 'local/remap', tree: 't', map: { 'a/b': 'z/b' } }).state;
    expect(next.questions.f?.context).toEqual(side('z/b'));
  });

  it('ignores identity pairs, the root key and other trees', () => {
    const state = hydrated(detail(failed('f', { parentId: 'a' })));
    expect(run(state, { type: 'local/remap', tree: 't', map: { a: 'a', '': 'x' } }).state).toBe(
      state,
    );
    expect(run(state, { type: 'local/remap', tree: 'u', map: { a: 'b' } }).state).toBe(state);
  });

  it('drops retained entries under deleted nodes', () => {
    const state = hydrated(
      detail(failed('f', { parentId: 'основы/x' })),
      detail(done('d', { parentId: '', nodeId: 'основы' })),
      detail(failed('g', { parentId: 'основы-2' })),
      detail(running('r', { parentId: 'основы' })),
    );
    const result = run(state, { type: 'local/dropUnder', tree: 't', ids: ['основы'] });
    expect(Object.keys(result.state.questions).sort()).toEqual(['g', 'r']);
    expect(result.lifecycle).toEqual([
      expect.objectContaining({ type: 'removed', reason: 'deleted', local: true }),
      expect.objectContaining({ type: 'removed', reason: 'deleted', local: true }),
    ]);
  });

  it('follows a tree rename', () => {
    const state = hydrated(detail(failed('f')));
    const next = run(state, { type: 'local/renameTree', from: 't', to: 'u' }).state;
    expect(next.questions.f?.tree).toBe('u');
    expect(run(state, { type: 'local/renameTree', from: 't', to: 't' }).state).toBe(state);
  });

  it('expires unconfirmed copies after the grace period', () => {
    let state = run(hydrated(), { type: 'http/question', question: running('a') }).state;
    expect(run(state, { type: 'expireUnconfirmed', now: NOW + 1000, graceMs: 5000 }).state).toBe(
      state,
    );
    const result = run(state, { type: 'expireUnconfirmed', now: NOW + 6000, graceMs: 5000 });
    state = result.state;
    expect(state.questions).toEqual({});
    expect(result.lifecycle).toEqual([
      expect.objectContaining({ type: 'removed', reason: 'missing', local: false }),
    ]);
  });
});

describe('selectors', () => {
  const cached = <T>(select: (state: QuestionsState) => T, equal: (a: T, b: T) => boolean) =>
    createCachedSelector(select, equal);

  it('keep their references across chunks', () => {
    const state = run(hydrated(detail(running('a'), 'x'), detail(failed('b', { createdAt: T1 }))), {
      type: 'outbox/add',
      entry: outbox('out-1'),
    }).state;
    const boxes = cached((s) => selectPendingBoxes(s, 't'), pendingBoxesEqual);
    const statuses = cached((s) => selectPendingStatuses(s, 't'), pendingStatusesEqual);
    const questions = cached((s) => selectTreeQuestions(s, 't'), treeQuestionsEqual);
    const busy = cached((s) => selectIsTreeBusy(s, 't'), Object.is);
    const before = [boxes(state), statuses(state), questions(state), busy(state)];
    const after = run(state, event(ev.chunk('a', 1, 'yz'))).state;
    expect(after).not.toBe(state);
    expect([boxes(after), statuses(after), questions(after), busy(after)]).toEqual(before);
    expect(boxes(after)).toBe(before[0]);
    expect(statuses(after)).toBe(before[1]);
    expect(questions(after)).toBe(before[2]);
  });

  it('keep the boxes but change the statuses on a status change', () => {
    const state = hydrated(detail(running('a'), 'x'));
    const boxes = cached((s) => selectPendingBoxes(s, 't'), pendingBoxesEqual);
    const statuses = cached((s) => selectPendingStatuses(s, 't'), pendingStatusesEqual);
    const beforeBoxes = boxes(state);
    const beforeStatuses = statuses(state);
    const after = run(state, event(ev.question(running('a', { status: 'naming' })))).state;
    expect(boxes(after)).toBe(beforeBoxes);
    expect(statuses(after)).not.toBe(beforeStatuses);
    expect(statuses(after).a?.status).toBe('naming');
  });

  it('returns the previous reference for an equal value', () => {
    let calls = 0;
    const select = createCachedSelector(
      (n: number) => {
        calls += 1;
        return [n % 2];
      },
      (a, b) => a[0] === b[0],
    );
    const first = select(1);
    expect(select(1)).toBe(first);
    expect(select(3)).toBe(first);
    expect(calls).toBe(2);
    expect(select(2)).not.toBe(first);
  });

  it('orders boxes by creation and keeps a done box until it is acked', () => {
    const state = hydrated(
      // First seen as done: acked at once, no box.
      detail(done('c', { createdAt: T0 })),
      detail(running('a', { createdAt: T1 })),
      detail(failed('b', { createdAt: T0, tree: 'u' })),
    );
    expect(selectPendingBoxes(state, 't').map((box) => box.key)).toEqual(['a']);
    const later = run(
      state,
      event(ev.question(running('e', { createdAt: T2 }))),
      event(ev.question(done('e', { createdAt: T2 }))),
    ).state;
    expect(selectPendingBoxes(later, 't').map((box) => [box.key, box.nodeId])).toEqual([
      ['a', null],
      ['e', 'основы/e'],
    ]);
  });

  it('counts running and failed answers per tree', () => {
    const state = run(
      hydrated(detail(running('a')), detail(failed('b')), detail(running('c', { tree: 'u' }))),
      { type: 'outbox/add', entry: outbox('out-1') },
    ).state;
    expect(selectTreeCounts(state)).toEqual({
      t: { running: 2, failed: 1 },
      u: { running: 1, failed: 0 },
    });
  });

  it('builds a question view', () => {
    const state = hydrated(detail(running('a'), 'x'));
    expect(selectQuestionView(state, 'a')).toEqual({
      info: state.questions.a,
      stream: state.streams.a,
      localFiles: null,
      cancelling: false,
      acked: false,
    });
    expect(selectQuestionView(state, 'zzz')).toBeNull();
  });
});

describe('labels', () => {
  it('cuts the server title to 40 graphemes for the box', () => {
    const title = `${'Почему заимствование работает так '.repeat(2)}…`;
    const label = pendingLabel(title);
    expect(label.endsWith('…')).toBe(true);
    expect([...new Intl.Segmenter().segment(label)]).toHaveLength(41);
    expect(pendingLabel('short  title')).toBe('short title');
  });

  it('uses file names for files-only messages', () => {
    expect(questionTitle('', ['a.pdf', 'b.png'])).toBe('a.pdf, b.png');
    expect(questionTitle('\n  First line \n second', [])).toBe('First line');
    expect(pendingTooltip('', ['a.pdf'])).toBe('a.pdf');
  });
});

describe('in-flight view', () => {
  const question = (info: QuestionInfo, cancelling = false) => ({
    kind: 'question' as const,
    info,
    stream: null,
    localFiles: null,
    cancelling,
  });

  it('maps statuses', () => {
    expect(inFlightStatus({ kind: 'outbox', entry: outbox('o') })).toBe('sending');
    expect(inFlightStatus({ kind: 'outbox', entry: outbox('o', { phase: 'uploading' }) })).toBe(
      'uploading',
    );
    expect(inFlightStatus({ kind: 'outbox', entry: outbox('o', { error: new Error() }) })).toBe(
      'not-sent',
    );
    expect(inFlightStatus(question(running('a')))).toBe('answering');
    expect(inFlightStatus(question(running('a', { status: 'naming' })))).toBe('saving');
    expect(inFlightStatus(question(done('a')))).toBe('saving');
    expect(inFlightStatus(question(failed('a')))).toBe('failed');
    expect(inFlightStatus(question(running('a'), true))).toBe('cancelling');
    expect(inFlightStatus({ kind: 'loading', id: 'a' })).toBe('loading');
  });

  it('offers cancel for live sends and streaming answers only', () => {
    expect(inFlightCanCancel({ kind: 'outbox', entry: outbox('o') })).toBe(true);
    expect(inFlightCanCancel({ kind: 'outbox', entry: outbox('o', { error: 1 }) })).toBe(false);
    expect(inFlightCanCancel(question(running('a')))).toBe(true);
    expect(inFlightCanCancel(question(running('a'), true))).toBe(false);
    expect(inFlightCanCancel(question(running('a', { status: 'naming' })))).toBe(false);
    expect(inFlightCanCancel(question(failed('a')))).toBe(false);
    expect(inFlightCanCancel({ kind: 'loading', id: 'a' })).toBe(false);
  });
});

describe('connection', () => {
  it('returns the same state for the same status', () => {
    const state = run(initialQuestionsState, { type: 'connection', status: 'live' }).state;
    expect(state.connection).toBe('live');
    expect(run(state, { type: 'connection', status: 'live' }).state).toBe(state);
  });
});
