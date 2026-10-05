import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { QuestionInfo, RunningQuestion } from '../api/types';
import type { ComposerFile } from './chat-files';
import { createQuestionStore, type QuestionApi } from './question-store';
import type { LifecycleEvent } from './questions';

const running = (id: string, overrides: Partial<RunningQuestion> = {}): RunningQuestion => ({
  id,
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  text: 'q',
  title: 'q',
  files: [],
  model: 'm',
  namingModel: 'n',
  attempt: 1,
  status: 'streaming',
  createdAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
  ...overrides,
});

interface PendingStart {
  resolve: (question: QuestionInfo) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}

function setup(overrides: Partial<QuestionApi> = {}) {
  const starts: PendingStart[] = [];
  const api = {
    startQuestion: vi.fn<QuestionApi['startQuestion']>(
      (_tree, _input, signal) =>
        new Promise<QuestionInfo>((resolve, reject) => {
          starts.push({ resolve, reject, signal });
          signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    ),
    cancelQuestion: vi.fn<QuestionApi['cancelQuestion']>(async () => undefined),
    retryQuestion: vi.fn<QuestionApi['retryQuestion']>(async (id) => running(id, { attempt: 2 })),
    ...overrides,
  };
  const scheduled: Array<() => void> = [];
  const store = createQuestionStore({
    api,
    now: () => 1_000,
    schedule: (callback) => scheduled.push(callback),
  });
  const lifecycle: LifecycleEvent[] = [];
  store.onLifecycle((event) => lifecycle.push(event));
  const runScheduled = () => {
    for (const callback of scheduled.splice(0)) callback();
  };
  return { api, store, starts, lifecycle, runScheduled };
}

const askInput = (files: ComposerFile[] = []) => ({
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' } as const,
  stashKey: 't:main',
  text: 'Вопрос',
  files,
  model: 'm',
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const hydrate = (store: ReturnType<typeof setup>['store'], ...questions: QuestionInfo[]) =>
  store.receive({
    event: 'snapshot',
    data: {
      instance: 'i',
      questions: questions.map((question) => ({
        ...question,
        live: { attempt: question.attempt, answer: '', attachments: [] },
      })),
    },
  });

describe('publishing', () => {
  it('updates the current state at once and the published one on flush', () => {
    const { store, runScheduled } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    hydrate(store, running('a'));
    store.setConnection('live');
    expect(store.getState().questions.a).toBeDefined();
    expect(store.getSnapshot().questions.a).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    runScheduled();
    expect(store.getSnapshot()).toBe(store.getState());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('runs lifecycle listeners synchronously, in order, after the state changed', () => {
    const { store } = setup();
    const seen: string[] = [];
    store.onLifecycle((event) => {
      seen.push(`${event.type}:${store.getState().questions.a?.status ?? '-'}`);
    });
    hydrate(store);
    store.receive({ event: 'question', data: { question: running('a') } });
    store.receive({ event: 'question', data: { question: running('a', { status: 'naming' }) } });
    expect(seen).toEqual(['added:streaming', 'naming:naming']);
  });

  it('reports a chunk gap as resync', () => {
    const { store } = setup();
    hydrate(store, running('a'));
    expect(
      store.receive({
        event: 'chunk',
        data: { id: 'a', tree: 't', attempt: 1, offset: 4, text: 'x' },
      }),
    ).toEqual({ resync: true });
  });
});

describe('ask', () => {
  it('adds an outbox entry and turns it into the question on 202', async () => {
    const { store, api, starts, lifecycle } = setup();
    hydrate(store);
    const file = { id: 1, file: new File(['x'], 'a.pdf') };
    const id = store.ask(askInput([file]));
    expect(store.getState().outbox[id]?.phase).toBe('uploading');
    expect(api.startQuestion).toHaveBeenCalledWith(
      't',
      {
        parentId: 'основы',
        text: 'Вопрос',
        model: 'm',
        namingModel: undefined,
        context: { kind: 'main' },
        files: [file.file],
      },
      expect.any(AbortSignal),
    );
    starts[0]?.resolve(running('q1'));
    await tick();
    const state = store.getState();
    expect(state.outbox).toEqual({});
    expect(state.localKeys.q1).toBe(id);
    expect(state.localFiles.q1).toEqual([file]);
    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({ type: 'accepted', outboxId: id, question: running('q1') }),
    );
  });

  it('keeps a failed send that its panel shows inline', async () => {
    const { store, starts, lifecycle } = setup();
    const id = store.ask(askInput());
    const onEnd = vi.fn(() => true);
    store.claimOutbox(id, onEnd);
    const error = new ApiError(404, 'gone', 'parent_not_found');
    starts[0]?.reject(error);
    await tick();
    expect(onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', error, entry: expect.objectContaining({ id }) }),
    );
    expect(store.getState().outbox[id]?.error).toBe(error);
    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({ type: 'outbox-ended', shown: true, restored: true }),
    );
  });

  it('drops an unclaimed failed send and reports it as not shown', async () => {
    const { store, starts, lifecycle } = setup();
    const id = store.ask(askInput());
    const release = store.claimOutbox(id, () => true);
    release();
    starts[0]?.reject(new TypeError('Failed to fetch'));
    await tick();
    expect(store.getState().outbox).toEqual({});
    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({
        type: 'outbox-ended',
        outcome: 'failed',
        shown: false,
        restored: false,
      }),
    );
  });

  it('drops a failed send whose panel moved on (claim returns false)', async () => {
    const { store, starts, lifecycle } = setup();
    const id = store.ask(askInput());
    store.claimOutbox(id, () => false);
    starts[0]?.reject(new Error('x'));
    await tick();
    expect(store.getState().outbox).toEqual({});
    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({ type: 'outbox-ended', shown: false, restored: true }),
    );
  });

  it('aborts an upload', async () => {
    const { store, starts, lifecycle } = setup();
    const id = store.ask(askInput());
    const onEnd = vi.fn(() => true);
    store.claimOutbox(id, onEnd);
    store.abortOutbox(id);
    expect(starts[0]?.signal?.aborted).toBe(true);
    await tick();
    expect(onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'aborted', error: null }),
    );
    expect(store.getState().outbox).toEqual({});
    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({ type: 'outbox-ended', outcome: 'aborted', shown: false }),
    );
  });
});

describe('cancel, dismiss, retry', () => {
  it('cancels: 204 removes locally (idempotent with the SSE event)', async () => {
    const { store, lifecycle } = setup();
    hydrate(store, running('a'));
    const promise = store.cancel('a');
    expect(store.getState().cancelling.a).toBe(true);
    // The server emits `removed` before its 204.
    store.receive({ event: 'removed', data: { id: 'a', tree: 't', reason: 'cancelled' } });
    await promise;
    expect(store.getState().questions.a).toBeUndefined();
    expect(store.getState().cancelling).toEqual({});
    const removed = lifecycle.filter((event) => event.type === 'removed');
    expect(removed).toEqual([expect.objectContaining({ reason: 'cancelled', local: true })]);
  });

  it('treats 404 question_not_found as removed', async () => {
    const { store } = setup({
      cancelQuestion: vi.fn(async () => {
        throw new ApiError(404, 'gone', 'question_not_found');
      }),
    });
    hydrate(store, running('a'));
    await store.cancel('a');
    expect(store.getState().questions.a).toBeUndefined();
  });

  it('treats 409 question_finished as "the done event already came"', async () => {
    const { store } = setup({
      cancelQuestion: vi.fn(async () => {
        throw new ApiError(409, 'done', 'question_finished', { nodeId: 'x' });
      }),
    });
    hydrate(store, running('a'));
    await expect(store.cancel('a')).resolves.toBeUndefined();
    expect(store.getState().questions.a).toBeDefined();
    expect(store.getState().cancelling).toEqual({});
  });

  it('rethrows other errors and ends the cancel', async () => {
    const error = new TypeError('Failed to fetch');
    const { store } = setup({
      cancelQuestion: vi.fn(async () => {
        throw error;
      }),
    });
    hydrate(store, running('a'));
    await expect(store.cancel('a')).rejects.toBe(error);
    expect(store.getState().cancelling).toEqual({});
    expect(store.getState().questions.a).toBeDefined();
  });

  it('dismisses a failed question as a local removal', async () => {
    const { store, lifecycle } = setup();
    hydrate(store, { ...running('a'), status: 'failed', error: { code: 'timeout', message: 'x' } });
    await store.dismiss('a');
    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({ type: 'removed', reason: 'dismissed', local: true }),
    );
  });

  it('merges a retry 202 by attempt', async () => {
    const { store, api } = setup();
    hydrate(store, {
      ...running('a'),
      status: 'failed',
      error: { code: 'internal', message: 'x' },
    });
    await store.retry('a');
    expect(api.retryQuestion).toHaveBeenCalledWith('a');
    expect(store.getState().questions.a).toEqual(running('a', { attempt: 2 }));
  });

  it('removes a question the retry no longer finds, so its panel says so', async () => {
    const { store, lifecycle } = setup({
      retryQuestion: vi.fn(async () => {
        throw new ApiError(404, 'gone', 'question_not_found');
      }),
    });
    hydrate(store, {
      ...running('a'),
      status: 'failed',
      error: { code: 'internal', message: 'x' },
    });
    await store.retry('a');
    expect(store.getState().questions.a).toBeUndefined();
    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({ type: 'removed', reason: 'missing', local: false }),
    );
  });

  it('rethrows other retry errors', async () => {
    const error = new ApiError(404, 'gone', 'parent_not_found');
    const { store } = setup({
      retryQuestion: vi.fn(async () => {
        throw error;
      }),
    });
    hydrate(store, {
      ...running('a'),
      status: 'failed',
      error: { code: 'internal', message: 'x' },
    });
    await expect(store.retry('a')).rejects.toBe(error);
    expect(store.getState().questions.a?.status).toBe('failed');
  });
});

describe('local changes', () => {
  it('applies remaps, drops and tree renames', () => {
    const { store } = setup();
    hydrate(store, {
      ...running('a'),
      status: 'failed',
      error: { code: 'internal', message: 'x' },
    });
    store.applyLocal({ kind: 'remap', tree: 't', map: { основы: 'база' } });
    expect(store.getState().questions.a?.parentId).toBe('база');
    store.applyLocal({ kind: 'renameTree', from: 't', to: 'u' });
    expect(store.getState().questions.a?.tree).toBe('u');
    store.applyLocal({ kind: 'dropUnder', tree: 'u', ids: ['база'] });
    expect(store.getState().questions).toEqual({});
  });
});
