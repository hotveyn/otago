import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QUESTION_TIMINGS,
  type QuestionContext,
  type QuestionInfo,
  QuestionRegistry,
  type QuestionRemovedReason,
  type QuestionTimings,
  type RegistryEvent,
  type RunningQuestion,
} from '../src/questions/index.js';
import { eventKinds } from './helpers.js';

let counter = 0;
function question(overrides: Partial<RunningQuestion> = {}): RunningQuestion {
  counter++;
  const createdAt = new Date(Date.UTC(2026, 9, 4, 10, 0, counter)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    tree: 'rust',
    parentId: '',
    context: { kind: 'main' },
    text: `Q${counter}`,
    title: `Q${counter}`,
    files: [],
    model: 'm',
    namingModel: 'n',
    attempt: 1,
    status: 'streaming',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const ready = (key: string, name: string) =>
  ({
    status: 'ready',
    key,
    attachment: { name, size: 1, contentType: 'text/plain', kind: 'text' },
  }) as const;
const saving = (key: string) => ({ status: 'saving', key, origin: 'inline' }) as const;

describe('QuestionRegistry', () => {
  let registry: QuestionRegistry;
  let events: RegistryEvent[];
  let removed: Array<[QuestionInfo, QuestionRemovedReason]>;
  let timings: QuestionTimings;

  function make(overrides: Partial<QuestionTimings> = {}) {
    timings = { ...DEFAULT_QUESTION_TIMINGS, ...overrides };
    registry = new QuestionRegistry({
      timings,
      onRemoved: (info, reason) => removed.push([info, reason]),
    });
    events = [];
    registry.subscribe({ onEvent: (event) => events.push(event), onEnd: () => undefined });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    removed = [];
    make();
  });
  afterEach(() => {
    registry.close();
    vi.useRealTimers();
  });

  /** Add a question and complete it (done) or fail it. */
  function finish(info: RunningQuestion, how: 'done' | 'failed', nodeId = `${info.text}`) {
    registry.add(info);
    if (how === 'done') registry.complete(info.id, 1, { nodeId, attachments: [], files: [] });
    else registry.fail(info.id, 1, { message: 'boom', code: 'agent_error' });
  }

  it('add emits question with increasing seq', () => {
    const a = question();
    const b = question();
    registry.add(a);
    registry.add(b);
    expect(events).toEqual([
      { seq: 1, event: 'question', data: { question: a } },
      { seq: 2, event: 'question', data: { question: b } },
    ]);
    expect(registry.get(a.id)).toEqual(a);
    expect(registry.detail(a.id)).toEqual({
      ...a,
      live: { attempt: 1, answer: '', attachments: [] },
    });
  });

  it('subscribe returns the snapshot and its seq in the same tick', () => {
    const a = question();
    registry.add(a);
    registry.appendChunk(a.id, 1, 'Hel');
    const seen: RegistryEvent[] = [];
    const { snapshot, unsubscribe } = registry.subscribe({
      onEvent: (event) => seen.push(event),
      onEnd: () => undefined,
    });
    expect(snapshot).toEqual({
      seq: 2,
      instance: registry.instance,
      questions: [{ ...a, live: { attempt: 1, answer: 'Hel', attachments: [] } }],
    });
    registry.appendChunk(a.id, 1, 'lo');
    expect(seen).toEqual([
      {
        seq: 3,
        event: 'chunk',
        data: { id: a.id, tree: 'rust', attempt: 1, offset: 3, text: 'lo' },
      },
    ]);
    unsubscribe();
    registry.appendChunk(a.id, 1, '!');
    expect(seen).toHaveLength(1);
  });

  it('chunks carry offsets; wrong attempt, status or id are ignored', () => {
    const a = question();
    registry.add(a);
    registry.appendChunk(a.id, 1, 'ab');
    registry.appendChunk(a.id, 1, 'cde');
    registry.appendChunk(a.id, 2, 'X');
    registry.appendChunk('unknown', 1, 'X');
    registry.appendChunk(a.id, 1, '');
    expect(
      events.filter((e) => e.event === 'chunk').map((e) => e.event === 'chunk' && e.data.offset),
    ).toEqual([0, 2]);
    registry.setNaming(a.id, 1);
    registry.appendChunk(a.id, 1, 'late');
    expect(registry.detail(a.id)?.live?.answer).toBe('abcde');
    expect(eventKinds(events)).toEqual(['question:streaming', 'chunk', 'chunk', 'question:naming']);
  });

  it('folds attachment events (latest per key, first-appearance order); drops them after naming', () => {
    const a = question();
    registry.add(a);
    registry.attachment(a.id, 1, saving('k1'));
    registry.attachment(a.id, 1, saving('k2'));
    registry.attachment(a.id, 1, ready('k1', 'one.txt'));
    registry.attachment(a.id, 2, ready('k2', 'wrong-attempt.txt'));
    expect(registry.detail(a.id)?.live?.attachments).toEqual([
      ready('k1', 'one.txt'),
      saving('k2'),
    ]);
    expect(events.filter((e) => e.event === 'attachment').map((e) => e.data)).toEqual([
      { id: a.id, tree: 'rust', attempt: 1, event: saving('k1') },
      { id: a.id, tree: 'rust', attempt: 1, event: saving('k2') },
      { id: a.id, tree: 'rust', attempt: 1, event: ready('k1', 'one.txt') },
    ]);
    registry.setNaming(a.id, 1);
    registry.attachment(a.id, 1, ready('k2', 'late.txt'));
    expect(registry.detail(a.id)?.live?.attachments).toHaveLength(2);
    expect(events.at(-1)?.event).toBe('question');
  });

  it('naming → done drops the live text; failed keeps the partial answer', () => {
    const a = question();
    const b = question();
    registry.add(a);
    registry.add(b);
    registry.appendChunk(a.id, 1, 'full');
    registry.appendChunk(b.id, 1, 'part');
    vi.advanceTimersByTime(1000);
    registry.setNaming(a.id, 1);
    expect(registry.get(a.id)?.status).toBe('naming');
    expect(registry.get(a.id)?.updatedAt).not.toBe(a.updatedAt);
    const files = [{ name: 'f.txt', size: 1, contentType: 'text/plain', kind: 'text' as const }];
    registry.complete(a.id, 1, { nodeId: 'node', attachments: [], files });
    expect(registry.detail(a.id)).toMatchObject({
      status: 'done',
      nodeId: 'node',
      attachments: [],
      files,
      live: null,
    });
    registry.fail(b.id, 1, { message: 'boom', code: 'agent_error' });
    expect(registry.detail(b.id)).toMatchObject({
      status: 'failed',
      error: { message: 'boom', code: 'agent_error' },
      live: { attempt: 1, answer: 'part' },
    });
    // Terminal entries ignore further mutations of the old attempt.
    registry.complete(b.id, 1, { nodeId: 'x', attachments: [], files: [] });
    expect(registry.get(b.id)?.status).toBe('failed');
  });

  it('beginAttempt: failed → streaming with attempt + 1, question before chunks, live reset', () => {
    const a = question();
    finish(a, 'failed');
    registry.appendChunk(a.id, 1, 'nope');
    expect(registry.beginAttempt('unknown')).toBeUndefined();
    const started = registry.beginAttempt(a.id);
    expect(started).toMatchObject({ id: a.id, attempt: 2, status: 'streaming' });
    expect(started).not.toHaveProperty('error');
    expect(registry.beginAttempt(a.id)).toBeUndefined();
    registry.appendChunk(a.id, 1, 'old attempt');
    registry.appendChunk(a.id, 2, 'new');
    expect(eventKinds(events)).toEqual([
      'question:streaming',
      'question:failed',
      'question:streaming',
      'chunk',
    ]);
    expect(events.at(-1)?.data).toMatchObject({ attempt: 2, offset: 0, text: 'new' });
    expect(registry.detail(a.id)?.live).toEqual({ attempt: 2, answer: 'new', attachments: [] });
    // The failed TTL was cleared by the retry.
    vi.advanceTimersByTime(timings.failedTtlMs + 1);
    expect(registry.get(a.id)?.status).toBe('streaming');
  });

  it('remove emits removed (with nodeId for done) and calls onRemoved', () => {
    const a = question();
    const b = question();
    finish(a, 'done', 'a-node');
    finish(b, 'failed');
    expect(registry.remove(a.id, 'expired')).toBe(true);
    expect(registry.remove(b.id, 'dismissed')).toBe(true);
    expect(registry.remove(b.id, 'dismissed')).toBe(false);
    expect(events.slice(-2).map((e) => e.data)).toEqual([
      { id: a.id, tree: 'rust', reason: 'expired', nodeId: 'a-node' },
      { id: b.id, tree: 'rust', reason: 'dismissed' },
    ]);
    expect(removed.map(([info, reason]) => [info.id, info.status, reason])).toEqual([
      [a.id, 'done', 'expired'],
      [b.id, 'failed', 'dismissed'],
    ]);
  });

  it('settled resolves on done/failed/removal, at once when terminal or unknown', async () => {
    const a = question();
    const b = question();
    const c = question();
    registry.add(a);
    registry.add(b);
    registry.add(c);
    const pa = registry.settled(a.id);
    const pb = registry.settled(b.id);
    const pc = registry.settled(c.id);
    registry.complete(a.id, 1, { nodeId: 'n', attachments: [], files: [] });
    registry.fail(b.id, 1, { message: 'x', code: 'internal' });
    registry.remove(c.id, 'cancelled');
    expect((await pa)?.status).toBe('done');
    expect((await pb)?.status).toBe('failed');
    expect(await pc).toBeUndefined();
    expect((await registry.settled(a.id))?.status).toBe('done');
    expect(await registry.settled('unknown')).toBeUndefined();
  });

  it('done entries expire after doneTtlMs; at most doneCapPerTree per tree', () => {
    make({ doneTtlMs: 1000, doneCapPerTree: 2 });
    const [a, b, c] = [question(), question(), question()];
    const other = question({ tree: 'go' });
    finish(a, 'done');
    finish(b, 'done');
    finish(other, 'done');
    finish(c, 'done');
    // The oldest done entry of `rust` was removed as expired; `go` is a separate tree.
    expect(events.filter((e) => e.event === 'removed').map((e) => e.data)).toEqual([
      { id: a.id, tree: 'rust', reason: 'expired', nodeId: a.text },
    ]);
    expect(registry.list().map((q) => q.id)).toEqual([b.id, c.id, other.id]);
    vi.advanceTimersByTime(999);
    expect(registry.list()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(registry.list()).toEqual([]);
  });

  it('failed entries expire after failedTtlMs; beyond the cap the oldest are evicted', () => {
    make({ failedTtlMs: 5000, failedCapPerTree: 2 });
    const [a, b, c] = [question(), question(), question()];
    finish(a, 'failed');
    vi.advanceTimersByTime(1000);
    finish(b, 'failed');
    finish(c, 'failed');
    expect(removed.map(([info, reason]) => [info.id, reason])).toEqual([[a.id, 'evicted']]);
    vi.advanceTimersByTime(4000);
    expect(registry.list().map((q) => q.id)).toEqual([b.id, c.id]);
    vi.advanceTimersByTime(1000);
    expect(registry.list()).toEqual([]);
    expect(removed.map(([, reason]) => reason)).toEqual(['evicted', 'expired', 'expired']);
  });

  it('remap: prefix rule on parentId, anchor and done nodeId; events for changed entries only', () => {
    const side = (anchor: string): QuestionContext => ({ kind: 'side', anchor });
    const failedUnder = question({ parentId: 'a/b', context: side('a') });
    const doneAt = question({ parentId: 'a' });
    const sibling = question({ parentId: 'ab', context: side('ab') });
    const running = question({ parentId: 'a' });
    const otherTree = question({ tree: 'go', parentId: 'a' });
    finish(failedUnder, 'failed');
    finish(doneAt, 'done', 'a/node');
    finish(sibling, 'failed');
    registry.add(running);
    finish(otherTree, 'failed');
    const before = events.length;

    registry.remap('rust', { a: 'x/a', unrelated: 'unrelated' });
    const changed = events.slice(before);
    expect(changed.map((e) => (e.event === 'question' ? e.data.question.id : ''))).toEqual([
      failedUnder.id,
      doneAt.id,
    ]);
    expect(registry.get(failedUnder.id)).toMatchObject({
      parentId: 'x/a/b',
      context: { kind: 'side', anchor: 'x/a' },
    });
    expect(registry.get(doneAt.id)).toMatchObject({ parentId: 'x/a', nodeId: 'x/a/node' });
    // `a` does not touch `ab`; running entries and other trees are left alone.
    expect(registry.get(sibling.id)).toMatchObject({ parentId: 'ab', context: side('ab') });
    expect(registry.get(running.id)?.parentId).toBe('a');
    expect(registry.get(otherTree.id)?.parentId).toBe('a');

    // Moving the parent out of the anchor's subtree resets the anchor to the parent.
    registry.remap('rust', { 'x/a/b': 'b' });
    expect(registry.get(failedUnder.id)).toMatchObject({ parentId: 'b', context: side('b') });
    // Identity maps emit nothing.
    const count = events.length;
    registry.remap('rust', { b: 'b' });
    registry.remap('rust', {});
    expect(events).toHaveLength(count);
  });

  it('dropUnder removes entries whose parent (or done node) is inside a deleted id', () => {
    const under = question({ parentId: 'a/b' });
    const at = question({ parentId: 'a' });
    const doneNode = question({ parentId: '' });
    const keep = question({ parentId: 'ab' });
    const running = question({ parentId: 'a' });
    finish(under, 'failed');
    finish(at, 'failed');
    finish(doneNode, 'done', 'a');
    finish(keep, 'failed');
    registry.add(running);
    registry.dropUnder('rust', ['a']);
    registry.dropUnder('rust', ['']);
    registry.dropUnder('go', ['ab']);
    expect(events.filter((e) => e.event === 'removed').map((e) => e.data)).toEqual([
      { id: under.id, tree: 'rust', reason: 'deleted' },
      { id: at.id, tree: 'rust', reason: 'deleted' },
      { id: doneNode.id, tree: 'rust', reason: 'deleted', nodeId: 'a' },
    ]);
    expect(registry.list().map((q) => q.id)).toEqual([keep.id, running.id]);
  });

  it('renameTree rewrites tree and emits question per entry', () => {
    const a = question();
    const b = question({ tree: 'go' });
    finish(a, 'failed');
    finish(b, 'failed');
    const before = events.length;
    registry.renameTree('rust', 'rust-basics');
    registry.renameTree('same', 'same');
    expect(events.slice(before).map((e) => e.event === 'question' && e.data.question.tree)).toEqual(
      ['rust-basics'],
    );
    expect(registry.list('rust-basics').map((q) => q.id)).toEqual([a.id]);
    expect(registry.list('rust')).toEqual([]);
  });

  it('blockers: running questions of the tree; unknown holders count as preparing', () => {
    const later = question({ title: 'later' });
    const earlier = question({ title: 'earlier', createdAt: '2026-01-01T00:00:00.000Z' });
    const failed = question();
    const otherTree = question({ tree: 'go' });
    registry.add(later);
    registry.add(earlier);
    registry.setNaming(earlier.id, 1);
    finish(failed, 'failed');
    registry.add(otherTree);
    expect(
      registry.blockers('rust', [
        later.id,
        'anon:1',
        earlier.id,
        failed.id,
        otherTree.id,
        later.id,
      ]),
    ).toEqual({
      questions: [
        {
          id: earlier.id,
          tree: 'rust',
          parentId: '',
          context: { kind: 'main' },
          title: 'earlier',
          status: 'naming',
        },
        {
          id: later.id,
          tree: 'rust',
          parentId: '',
          context: { kind: 'main' },
          title: 'later',
          status: 'streaming',
        },
      ],
      preparing: 3,
    });
    expect(registry.blockers('rust', [])).toEqual({ questions: [], preparing: 0 });
  });

  it('filters subscribers by the current tree', () => {
    const seen: RegistryEvent[] = [];
    registry.subscribe({ tree: 'go', onEvent: (e) => seen.push(e), onEnd: () => undefined });
    const a = question();
    const b = question({ tree: 'go' });
    registry.add(a);
    registry.add(b);
    registry.appendChunk(a.id, 1, 'x');
    registry.appendChunk(b.id, 1, 'y');
    registry.remove(b.id, 'cancelled');
    expect(eventKinds(seen)).toEqual(['question:streaming', 'chunk', 'removed:cancelled']);
    expect(
      registry.subscribe({ tree: 'go', onEvent: () => {}, onEnd: () => {} }).snapshot.questions,
    ).toEqual([]);
  });

  it('isolates a throwing listener; endSubscribers ends every stream once', () => {
    const ended: string[] = [];
    registry.subscribe({
      onEvent: () => {
        throw new Error('broken');
      },
      onEnd: () => {
        ended.push('broken');
        throw new Error('broken end');
      },
    });
    registry.subscribe({ onEvent: () => undefined, onEnd: () => ended.push('ok') });
    const a = question();
    registry.add(a);
    expect(events).toHaveLength(1);
    registry.endSubscribers();
    registry.endSubscribers();
    expect(ended).toEqual(['broken', 'ok']);
    registry.appendChunk(a.id, 1, 'x');
    expect(events).toHaveLength(1);
  });

  it('close clears entries and timers, settles waiters and stops events', async () => {
    const a = question();
    const b = question();
    registry.add(a);
    finish(b, 'failed');
    const waiting = registry.settled(a.id);
    registry.close();
    expect(await waiting).toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    registry.add(question());
    expect(registry.list()).toEqual([]);
  });
});
