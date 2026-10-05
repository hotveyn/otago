export interface SseEvent {
  event: string;
  data: string;
  /** The block's `id:` field, when present (ignored when it contains NUL, per WHATWG). */
  id?: string;
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
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id' && !value.includes('\u0000')) id = value;
      }
      if (data.length > 0)
        events.push(
          id === undefined
            ? { event, data: data.join('\n') }
            : { event, data: data.join('\n'), id },
        );
    }
    return events;
  };
}

export interface ReadSseOptions {
  /** Called after every read that delivered bytes (comments such as `: ping` included). */
  onBytes?: () => void;
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > 0) options.onBytes?.();
      yield* parse(decoder.decode(value, { stream: true }));
    }
    yield* parse(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
