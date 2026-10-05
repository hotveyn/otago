import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSse, SSE_HEADERS, type SseTarget } from '../src/routes/sse.js';
import { parseSse } from './helpers.js';

class FakeRaw extends EventEmitter {
  chunks: string[] = [];
  head?: { status: number; headers: unknown };
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  /** Bytes "stuck" in the socket buffer after each write (slow consumer). */
  buffered = 0;

  writeHead(status: number, headers: unknown) {
    this.head = { status, headers };
    return this;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    this.writableLength += this.buffered ? chunk.length : 0;
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
  get body() {
    return this.chunks.join('');
  }
}

function target(raw: FakeRaw): SseTarget & { hijacked: boolean } {
  const reply = {
    hijacked: false,
    hijack() {
      reply.hijacked = true;
    },
    raw: raw as unknown as SseTarget['raw'],
  };
  return reply;
}

const options = { retryMs: 2000, pingIntervalMs: 1000, maxBufferedBytes: 100 };

describe('openSse', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hijacks, writes the headers and retry first, then id/event/data frames', () => {
    const raw = new FakeRaw();
    const reply = target(raw);
    const sse = openSse(reply, options);
    expect(reply.hijacked).toBe(true);
    expect(raw.head).toEqual({ status: 200, headers: SSE_HEADERS });
    expect(SSE_HEADERS).toEqual({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    sse.send(7, 'chunk', { text: 'a\nb', emoji: '👍' });
    expect(raw.chunks).toEqual([
      'retry: 2000\n\n',
      'id: 7\nevent: chunk\ndata: {"text":"a\\nb","emoji":"👍"}\n\n',
    ]);
    expect(parseSse(raw.body)).toEqual([
      { retry: 2000 },
      { id: '7', event: 'chunk', data: { text: 'a\nb', emoji: '👍' } },
    ]);
  });

  it('pings every interval until closed', () => {
    const raw = new FakeRaw();
    const sse = openSse(target(raw), options);
    vi.advanceTimersByTime(2500);
    expect(raw.chunks.filter((c) => c === ': ping\n\n')).toHaveLength(2);
    const closed = vi.fn();
    sse.onClose(closed);
    sse.end();
    expect(raw.writableEnded).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sse.closed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(raw.chunks.filter((c) => c === ': ping\n\n')).toHaveLength(2);
    sse.send(1, 'question', {});
    expect(raw.chunks.at(-1)).toBe(': ping\n\n');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroys a slow consumer above maxBufferedBytes', () => {
    const raw = new FakeRaw();
    raw.buffered = 1;
    const sse = openSse(target(raw), options);
    const closed = vi.fn();
    sse.onClose(closed);
    sse.send(1, 'chunk', { text: 'x'.repeat(20) });
    expect(raw.destroyed).toBe(false);
    sse.send(2, 'chunk', { text: 'x'.repeat(200) });
    expect(raw.destroyed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    const count = raw.chunks.length;
    sse.send(3, 'chunk', { text: 'more' });
    expect(raw.chunks).toHaveLength(count);
  });

  it('runs close callbacks once when the client goes away; late callbacks run at once', () => {
    const raw = new FakeRaw();
    const sse = openSse(target(raw), options);
    const first = vi.fn();
    const throwing = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const second = vi.fn();
    sse.onClose(first);
    sse.onClose(throwing);
    sse.onClose(second);
    raw.emit('close');
    raw.emit('close');
    expect(first).toHaveBeenCalledTimes(1);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    sse.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(raw.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
