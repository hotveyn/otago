import { describe, expect, it, vi } from 'vitest';
import { createSseParser, readSse } from './sse';

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe('createSseParser', () => {
  it('parses events split across chunks', () => {
    const parse = createSseParser();
    expect(parse('event: chunk\ndata: "Hel')).toEqual([]);
    expect(parse('lo"\n\nevent: done\ndata: {"nodeId":"a"}\n\n')).toEqual([
      { event: 'chunk', data: '"Hello"' },
      { event: 'done', data: '{"nodeId":"a"}' },
    ]);
  });

  it('handles CRLF, comments and multi-line data', () => {
    const parse = createSseParser();
    expect(parse(': ping\r\n\r\ndata: a\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'message', data: 'a\nb' },
    ]);
  });

  it('reads the id field and ignores one containing NUL', () => {
    const parse = createSseParser();
    expect(parse('id: 7\nevent: chunk\ndata: {}\n\nid: 8\u00009\ndata: x\n\n')).toEqual([
      { event: 'chunk', data: '{}', id: '7' },
      { event: 'message', data: 'x' },
    ]);
  });

  it('dispatches nothing for retry-only and id-only blocks', () => {
    const parse = createSseParser();
    expect(parse('retry: 2000\n\nid: 3\n\n')).toEqual([]);
  });
});

describe('readSse', () => {
  it('yields events and reports every read with bytes, pings included', async () => {
    const onBytes = vi.fn();
    const events = [];
    for await (const event of readSse(stream([': ping\n\n', 'event: a\ndata: 1\n\n']), { onBytes }))
      events.push(event);
    expect(events).toEqual([{ event: 'a', data: '1' }]);
    expect(onBytes).toHaveBeenCalledTimes(2);
  });
});
