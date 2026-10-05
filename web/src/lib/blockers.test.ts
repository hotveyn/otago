import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { BlockingQuestion, RunningQuestion } from '../api/types';
import { blockerList, blockerListEqual, finishedNodeIdOf, treeBusyDetailsOf } from './blockers';
import { initialQuestionsState, type OutboxEntry, type QuestionsState } from './questions';

const blocking = (id: string, overrides: Partial<BlockingQuestion> = {}): BlockingQuestion => ({
  id,
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  title: `Q ${id}`,
  status: 'streaming',
  ...overrides,
});

const running = (id: string, overrides: Partial<RunningQuestion> = {}): RunningQuestion => ({
  id,
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  text: 'q',
  title: `Q ${id}`,
  files: [],
  model: 'm',
  namingModel: 'n',
  attempt: 1,
  status: 'streaming',
  createdAt: 'c',
  updatedAt: 'u',
  ...overrides,
});

const busy = (details: unknown) => new ApiError(409, 'busy', 'tree_busy_streaming', details);

describe('treeBusyDetailsOf', () => {
  it('reads valid details and filters malformed items', () => {
    const error = busy({
      questions: [blocking('a'), { id: 1 }, blocking('b', { status: 'naming' }), null],
      preparing: 2,
    });
    expect(treeBusyDetailsOf(error)).toEqual({
      questions: [blocking('a'), blocking('b', { status: 'naming' })],
      preparing: 2,
    });
  });

  it('defaults missing fields and rejects other errors', () => {
    expect(treeBusyDetailsOf(busy({}))).toEqual({ questions: [], preparing: 0 });
    expect(treeBusyDetailsOf(busy(undefined))).toBeNull();
    expect(treeBusyDetailsOf(new ApiError(409, 'busy', 'tree_busy_structural', {}))).toBeNull();
    expect(treeBusyDetailsOf(new Error('x'))).toBeNull();
  });

  it('reads the node of question_finished', () => {
    expect(
      finishedNodeIdOf(new ApiError(409, 'x', 'question_finished', { nodeId: 'основы/a' })),
    ).toBe('основы/a');
    expect(finishedNodeIdOf(new ApiError(409, 'x', 'question_finished'))).toBeNull();
  });
});

describe('blockerList', () => {
  const store = (extra: Partial<QuestionsState> = {}): QuestionsState => ({
    ...initialQuestionsState,
    hydrated: true,
    snapshotCount: 1,
    questions: {
      a: running('a'),
      n: running('n', { status: 'naming', createdAt: 'd' }),
      f: { ...running('f'), status: 'failed', error: { code: 'internal', message: 'x' } },
      other: running('other', { tree: 'u' }),
    },
    ...extra,
  });

  it('lists the store running questions of the tree', () => {
    const list = blockerList(store({ cancelling: { a: true } }), 't', {
      details: null,
      snapshotCount: 1,
    });
    expect(list.items.map((item) => [item.id, item.status, item.cancelling, item.source])).toEqual([
      ['a', 'streaming', true, 'store'],
      ['n', 'naming', false, 'store'],
    ]);
    expect(list.preparing).toBe(0);
  });

  it('adds server-only blockers until the store knows better', () => {
    const details = {
      questions: [
        blocking('a'),
        blocking('s'),
        blocking('gone'),
        blocking('f'),
        blocking('x', { tree: 'u' }),
      ],
      preparing: 1,
    };
    const opened = { details, snapshotCount: 1 };
    const list = blockerList(store({ tombstones: ['gone'] }), 't', opened);
    expect(list.items.map((item) => [item.id, item.source])).toEqual([
      ['a', 'store'],
      ['n', 'store'],
      ['s', 'server'],
    ]);
    expect(list.preparing).toBe(1);
    // A newer snapshot is authoritative: server-only items go.
    const later = blockerList(store({ snapshotCount: 2 }), 't', opened);
    expect(later.items.map((item) => item.id)).toEqual(['a', 'n']);
  });

  it('counts this tab’s uploads to the tree', () => {
    const entry: OutboxEntry = {
      id: 'out-1',
      tree: 't',
      parentId: '',
      context: { kind: 'main' },
      stashKey: 't:main',
      text: 'q',
      files: [],
      phase: 'uploading',
      error: null,
      createdAt: 'c',
    };
    const list = blockerList(
      store({ outbox: { 'out-1': entry, 'out-2': { ...entry, id: 'out-2', error: new Error() } } }),
      't',
      { details: null, snapshotCount: 1 },
    );
    expect(list.uploading).toBe(1);
  });

  it('compares lists by value', () => {
    const opened = { details: null, snapshotCount: 1 };
    const a = blockerList(store(), 't', opened);
    const b = blockerList({ ...store(), streams: {} }, 't', opened);
    expect(a).not.toBe(b);
    expect(blockerListEqual(a, b)).toBe(true);
    expect(blockerListEqual(a, blockerList(store({ cancelling: { a: true } }), 't', opened))).toBe(
      false,
    );
  });
});
