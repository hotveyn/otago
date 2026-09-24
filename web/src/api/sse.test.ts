import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse';

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
});
