import type { ServerResponse } from 'node:http';

/** Response headers of an SSE stream (contract `question-events.ts`). */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

export interface SseOptions {
  /** Sent once as `retry: <ms>` before anything else. */
  retryMs: number;
  /** Interval of the `: ping` keep-alive comment. */
  pingIntervalMs: number;
  /** Slow-consumer cut-off: above this many buffered bytes the connection is destroyed. */
  maxBufferedBytes: number;
}

/** The parts of a Fastify reply `openSse` needs (a fake in tests). */
export interface SseTarget {
  hijack(): unknown;
  raw: Pick<
    ServerResponse,
    'writeHead' | 'write' | 'end' | 'destroy' | 'on' | 'off' | 'writableLength' | 'writableEnded'
  > & { destroyed: boolean };
}

export interface SseStream {
  /** Write one event (`id:`/`event:`/`data:`). No-op once closed. */
  send(seq: number, event: string, data: unknown): void;
  /** End the response (server shutdown). */
  end(): void;
  /** Runs once when the connection closes (client gone, ended or destroyed). */
  onClose(callback: () => void): void;
  readonly closed: boolean;
}

/**
 * Take over the reply and turn it into a Server-Sent Events stream: headers, `retry:`, events,
 * `: ping` comments and slow-consumer protection. The stream never ends on its own.
 */
export function openSse(reply: SseTarget, options: SseOptions): SseStream {
  reply.hijack();
  const raw = reply.raw;
  const callbacks: Array<() => void> = [];
  let closed = false;

  const writable = () => !closed && !raw.destroyed && !raw.writableEnded;
  const write = (chunk: string) => {
    if (!writable()) return;
    raw.write(chunk);
    // The client does not read fast enough: drop it; it reconnects and gets a fresh snapshot.
    if (raw.writableLength > options.maxBufferedBytes) raw.destroy();
  };

  const ping = setInterval(() => write(': ping\n\n'), options.pingIntervalMs);
  ping.unref?.();

  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    raw.off('close', onClose);
    for (const callback of callbacks.splice(0)) {
      try {
        callback();
      } catch {
        // Cleanup of one listener must not stop the others.
      }
    }
  };
  raw.on('close', onClose);

  raw.writeHead(200, SSE_HEADERS);
  write(`retry: ${options.retryMs}\n\n`);

  return {
    send(seq, event, data) {
      write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      clearInterval(ping);
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    },
    onClose(callback) {
      if (closed) callback();
      else callbacks.push(callback);
    },
    get closed() {
      return closed;
    },
  };
}
