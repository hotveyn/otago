import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionConnectionHandlers } from '../api/question-events';
import { createQuestionStore, type QuestionApi } from './question-store';
import { startQuestionSync, UNCONFIRMED_CHECK_MS } from './question-sync';

const api: QuestionApi = {
  startQuestion: vi.fn(),
  cancelQuestion: vi.fn(),
  retryQuestion: vi.fn(),
};

function setup(options: { hidden?: boolean; hiddenDisconnectMs?: number | null } = {}) {
  const store = createQuestionStore({ api, now: () => Date.now(), schedule: (cb) => cb() });
  let handlers: QuestionConnectionHandlers | undefined;
  const connection = {
    start: vi.fn(() => handlers?.onStatus('connecting')),
    stop: vi.fn(() => handlers?.onStatus('paused')),
    resync: vi.fn(),
  };
  const doc = Object.assign(new EventTarget(), { hidden: options.hidden ?? false });
  const win = new EventTarget();
  const stop = startQuestionSync(store, {
    connect: (h) => {
      handlers = h;
      return connection;
    },
    doc,
    win,
    hiddenDisconnectMs:
      options.hiddenDisconnectMs === undefined ? 30_000 : options.hiddenDisconnectMs,
    unconfirmedGraceMs: 10_000,
  });
  const live = () => {
    handlers?.onEvent({ event: 'snapshot', data: { instance: 'i', questions: [] } });
    handlers?.onStatus('live');
  };
  return { store, connection, doc, win, stop, live, handlers: () => handlers };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startQuestionSync', () => {
  it('starts the connection and feeds events and statuses into the store', () => {
    const { store, connection, live, stop } = setup();
    expect(connection.start).toHaveBeenCalledTimes(1);
    expect(store.getState().connection).toBe('connecting');
    live();
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().connection).toBe('live');
    stop();
    expect(connection.stop).toHaveBeenCalled();
  });

  it('resyncs on a chunk gap', () => {
    const { connection, live, handlers, stop } = setup();
    live();
    handlers()?.onEvent({
      event: 'question',
      data: {
        question: {
          id: 'a',
          tree: 't',
          parentId: '',
          context: { kind: 'main' },
          text: 'q',
          title: 'q',
          files: [],
          model: 'm',
          namingModel: 'n',
          attempt: 1,
          status: 'streaming',
          createdAt: 'c',
          updatedAt: 'u',
        },
      },
    });
    handlers()?.onEvent({
      event: 'chunk',
      data: { id: 'a', tree: 't', attempt: 1, offset: 10, text: 'x' },
    });
    expect(connection.resync).toHaveBeenCalledTimes(1);
    stop();
  });

  it('disconnects a tab hidden for long and reconnects when it is visible again', () => {
    const { connection, doc, live, stop } = setup();
    live();
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(29_999);
    expect(connection.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(connection.stop).toHaveBeenCalledTimes(1);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(connection.start).toHaveBeenCalledTimes(2);
    stop();
  });

  it('cancels the disconnect when the tab comes back early', () => {
    const { connection, doc, live, stop } = setup();
    live();
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(10_000);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(60_000);
    expect(connection.stop).not.toHaveBeenCalled();
    expect(connection.start).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps hidden tabs connected with hiddenDisconnectMs: null', () => {
    const { connection, doc, stop } = setup({ hidden: true, hiddenDisconnectMs: null });
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(120_000);
    expect(connection.stop).not.toHaveBeenCalled();
    stop();
  });

  it('resyncs on online when not live', () => {
    const { connection, win, live, stop } = setup();
    win.dispatchEvent(new Event('online'));
    expect(connection.resync).toHaveBeenCalledTimes(1);
    live();
    win.dispatchEvent(new Event('online'));
    expect(connection.resync).toHaveBeenCalledTimes(1);
    stop();
  });

  it('expires unconfirmed 202 copies while live', async () => {
    const { store, live, stop } = setup();
    live();
    // A 202 copy the stream never confirms.
    const startQuestion = vi.mocked(api.startQuestion);
    startQuestion.mockResolvedValueOnce({
      id: 'ghost',
      tree: 't',
      parentId: '',
      context: { kind: 'main' },
      text: 'q',
      title: 'q',
      files: [],
      model: 'm',
      namingModel: 'n',
      attempt: 1,
      status: 'streaming',
      createdAt: 'c',
      updatedAt: 'u',
    });
    store.ask({
      tree: 't',
      parentId: '',
      context: { kind: 'main' },
      stashKey: 't:main',
      text: 'q',
      files: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().questions.ghost).toBeDefined();
    await vi.advanceTimersByTimeAsync(UNCONFIRMED_CHECK_MS * 2);
    expect(store.getState().questions.ghost).toBeDefined();
    await vi.advanceTimersByTimeAsync(UNCONFIRMED_CHECK_MS);
    expect(store.getState().questions.ghost).toBeUndefined();
    stop();
  });
});
