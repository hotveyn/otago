export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental parser for `text/event-stream`; feed it decoded text as it arrives. */
export function createSseParser() {
  let buffer = '';
  return (text: string): SseEvent[] => {
    buffer += text.replace(/\r\n?/g, '\n');
    const events: SseEvent[] = [];
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) events.push({ event, data: data.join('\n') });
    }
    return events;
  };
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* parse(decoder.decode(value, { stream: true }));
    }
    yield* parse(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
