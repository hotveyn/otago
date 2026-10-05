import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../lib/questions';
import {
  createQuestionConnection,
  nextBackoff,
  parseQuestionEvent,
  QUESTION_EVENTS_URL,
  QUESTION_EVENTS_WATCHDOG_MS,
  QuestionProtocolError,
} from './question-events';
import type { QuestionStreamEvent } from './types';

const question = {
  id: 'q1',
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
};

const frame = (name: string, data: unknown, id = 1) =>
  `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const snapshotFrame = (instance = 'i1') => frame('snapshot', { instance, questions: [] }, 0);

/** An SSE response the test writes to; it errors when the request is aborted (like fetch). */
function sseStream(signal?: AbortSignal | null) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    if (closed) return;
    closed = true;
    controller?.error(new DOMException('Aborted', 'AbortError'));
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
    push: (text: string) => {
      if (!closed) controller?.enqueue(encoder.encode(text));
    },
    close: () => {
      closed = true;
      controller?.close();
    },
    get aborted() {
      return signal?.aborted ?? false;
    },
  };
}

function harness() {
  const streams: ReturnType<typeof sseStream>[] = [];
  const queued: Response[] = [];
  const events: QuestionStreamEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const next = queued.shift();
    if (next) return next;
    const stream = sseStream(init?.signal);
    streams.push(stream);
    return stream.response;
  });
  const connection = createQuestionConnection({
    fetch,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    // Full jitter at its maximum: delays are exactly the cap (500 ms, 1 s, 2 s, …).
    random: () => 1,
  });
  return { connection, fetch, streams, queued, events, statuses };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseQuestionEvent', () => {
  it('parses every known event', () => {
    expect(
      parseQuestionEvent({ event: 'snapshot', data: '{"instance":"i","questions":[]}' }),
    ).toEqual({ event: 'snapshot', data: { instance: 'i', questions: [] } });
    expect(
      parseQuestionEvent({ event: 'question', data: JSON.stringify({ question }) })?.event,
    ).toBe('question');
    const chunk = { id: 'q1', tree: 't', attempt: 1, offset: 0, text: 'Привет' };
    expect(parseQuestionEvent({ event: 'chunk', data: JSON.stringify(chunk) })).toEqual({
      event: 'chunk',
      data: chunk,
    });
    const attachment = {
      id: 'q1',
      tree: 't',
      attempt: 1,
      event: { status: 'saving', key: 'k', origin: 'inline' },
    };
    expect(
      parseQuestionEvent({ event: 'attachment', data: JSON.stringify(attachment) })?.event,
    ).toBe('attachment');
    expect(
      parseQuestionEvent({ event: 'removed', data: '{"id":"q1","tree":"t","reason":"expired"}' }),
    ).toEqual({ event: 'removed', data: { id: 'q1', tree: 't', reason: 'expired' } });
  });

  it('ignores unknown events', () => {
    expect(parseQuestionEvent({ event: 'tree_changed', data: 'not json' })).toBeNull();
    expect(parseQuestionEvent({ event: 'message', data: '{}' })).toBeNull();
  });

  it('throws on malformed known events', () => {
    expect(() => parseQuestionEvent({ event: 'chunk', data: 'nope' })).toThrow(
      QuestionProtocolError,
    );
    expect(() =>
      parseQuestionEvent({ event: 'chunk', data: '{"id":"q","attempt":1,"offset":"0","text":""}' }),
    ).toThrow(QuestionProtocolError);
    expect(() => parseQuestionEvent({ event: 'snapshot', data: '{"instance":"i"}' })).toThrow(
      QuestionProtocolError,
    );
    expect(() =>
      parseQuestionEvent({ event: 'snapshot', data: '{"instance":"i","questions":[{}]}' }),
    ).toThrow(QuestionProtocolError);
    expect(() => parseQuestionEvent({ event: 'question', data: '{"question":null}' })).toThrow(
      QuestionProtocolError,
    );
  });
});

describe('nextBackoff', () => {
  it('grows exponentially, stays within the cap and uses full jitter', () => {
    expect(nextBackoff(0, {}, () => 1)).toBe(500);
    expect(nextBackoff(3, {}, () => 1)).toBe(4000);
    expect(nextBackoff(30, {}, () => 1)).toBe(10_000);
    expect(nextBackoff(5, {}, () => 0)).toBe(0);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const delay = nextBackoff(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(10_000);
    }
  });
});

describe('createQuestionConnection', () => {
  it('goes live after the snapshot and forwards events', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    expect(h.fetch).toHaveBeenCalledWith(
      QUESTION_EVENTS_URL,
      expect.objectContaining({ cache: 'no-store', headers: { accept: 'text/event-stream' } }),
    );
    expect(h.statuses).toEqual(['connecting']);
    h.streams[0]?.push(`retry: 2000\n\n${snapshotFrame()}`);
    await flush();
    expect(h.statuses).toEqual(['connecting', 'live']);
    h.streams[0]?.push(frame('chunk', { id: 'q1', tree: 't', attempt: 1, offset: 0, text: 'a' }));
    h.streams[0]?.push('event: future\ndata: {}\n\n');
    await flush();
    expect(h.events.map((event) => event.event)).toEqual(['snapshot', 'chunk']);
    h.connection.stop();
  });

  it('retries after a proxy 502 and a wrong content type', async () => {
    const h = harness();
    h.queued.push(
      new Response('Bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } }),
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    h.connection.start();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(499);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    // Second failure: the backoff doubles.
    await vi.advanceTimersByTimeAsync(999);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.streams[0]?.push(snapshotFrame());
    await flush();
    expect(h.statuses.at(-1)).toBe('live');
    h.connection.stop();
  });

  it('reconnects when the stream ends, with the backoff reset by the snapshot', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.streams[0]?.push(snapshotFrame());
    await flush();
    h.streams[0]?.close();
    await flush();
    expect(h.statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.connection.stop();
  });

  it('aborts after the watchdog period without bytes; pings keep it alive', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.streams[0]?.push(snapshotFrame());
    await flush();
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(QUESTION_EVENTS_WATCHDOG_MS - 1000);
      h.streams[0]?.push(': ping\n\n');
      await flush();
    }
    expect(h.streams[0]?.aborted).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUESTION_EVENTS_WATCHDOG_MS);
    expect(h.streams[0]?.aborted).toBe(true);
    expect(h.statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.connection.stop();
  });

  it('treats a first event other than snapshot as a protocol error', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.streams[0]?.push(frame('question', { question }));
    await flush();
    expect(h.events).toEqual([]);
    expect(h.streams[0]?.aborted).toBe(true);
    expect(h.statuses.at(-1)).toBe('reconnecting');
    h.connection.stop();
  });

  it('resync reconnects at once, also during a backoff sleep', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.streams[0]?.push(snapshotFrame());
    await flush();
    h.connection.resync();
    await flush();
    expect(h.streams[0]?.aborted).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    // Now fail and resync while sleeping.
    h.streams[1]?.close();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.connection.resync();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.connection.stop();
  });

  it('stop pauses without reconnecting until start', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.connection.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.statuses.at(-1)).toBe('paused');
    h.connection.start();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.connection.stop();
  });
});
