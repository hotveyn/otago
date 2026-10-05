/**
 * Client of `GET /api/questions/events` (.claude/features/parallel-questions/contracts/
 * question-events.ts): ONE `fetch` + `readSse` loop per tab (not `EventSource`), so it survives
 * the Vite proxy's 502 on server restarts and can run a liveness watchdog.
 * `retry:` and `id:` are ignored: every (re)connection starts with a full snapshot.
 */
import type { ConnectionStatus } from '../lib/questions';
import { readSse, type SseEvent } from './sse';
import type { QuestionStreamEvent } from './types';

export const QUESTION_EVENTS_URL = '/api/questions/events';
/** Contract `SSE_PING_INTERVAL_MS`. */
export const SSE_PING_INTERVAL_MS = 15_000;
/** Three missed pings ⇒ the connection is dead (half-open TCP after sleep, …). */
export const QUESTION_EVENTS_WATCHDOG_MS = 3 * SSE_PING_INTERVAL_MS;

/** A known event with a body that does not match the contract. */
export class QuestionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionProtocolError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(event: string, reason: string): never {
  throw new QuestionProtocolError(`Malformed "${event}" event: ${reason}`);
}

function requireString(event: string, data: Record<string, unknown>, key: string): void {
  if (typeof data[key] !== 'string') fail(event, `"${key}" must be a string`);
}

function requireNumber(event: string, data: Record<string, unknown>, key: string): void {
  const value = data[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(event, `"${key}" must be a number`);
}

function requireQuestion(event: string, value: unknown): void {
  if (!isRecord(value)) fail(event, 'question must be an object');
  requireString(event, value, 'id');
  requireString(event, value, 'tree');
  requireString(event, value, 'status');
  requireNumber(event, value, 'attempt');
}

const KNOWN = new Set(['snapshot', 'question', 'chunk', 'attachment', 'removed']);

/**
 * One SSE event → a typed stream event. Unknown names → `null` (forward compatibility, e.g. a
 * future `tree_changed`). Known names with bad JSON or a bad shape throw `QuestionProtocolError`.
 * The guards are minimal: the server is trusted, this only catches a broken connection.
 */
export function parseQuestionEvent(sse: SseEvent): QuestionStreamEvent | null {
  const name = sse.event;
  if (!KNOWN.has(name)) return null;
  let data: unknown;
  try {
    data = JSON.parse(sse.data);
  } catch {
    fail(name, 'invalid JSON');
  }
  if (!isRecord(data)) fail(name, 'data must be an object');
  switch (name) {
    case 'snapshot':
      requireString(name, data, 'instance');
      if (!Array.isArray(data.questions)) fail(name, '"questions" must be an array');
      for (const question of data.questions) requireQuestion(name, question);
      return { event: 'snapshot', data: data as never };
    case 'question':
      requireQuestion(name, data.question);
      return { event: 'question', data: data as never };
    case 'chunk':
      requireString(name, data, 'id');
      requireNumber(name, data, 'attempt');
      requireNumber(name, data, 'offset');
      requireString(name, data, 'text');
      return { event: 'chunk', data: data as never };
    case 'attachment':
      requireString(name, data, 'id');
      requireNumber(name, data, 'attempt');
      if (!isRecord(data.event)) fail(name, '"event" must be an object');
      return { event: 'attachment', data: data as never };
    case 'removed':
      requireString(name, data, 'id');
      requireString(name, data, 'reason');
      return { event: 'removed', data: data as never };
    default:
      return null;
  }
}

export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
}

/** Delay before reconnect number `attempt` (0-based): exponential, capped, full jitter. */
export function nextBackoff(
  attempt: number,
  { initialMs = 500, maxMs = 10_000 }: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const cap = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * cap);
}

export interface QuestionConnection {
  /** Connect (no-op while running). */
  start(): void;
  /** Disconnect and stay disconnected (`paused`) until `start()`. */
  stop(): void;
  /** Drop the current connection and reconnect at once (fresh snapshot). */
  resync(): void;
}

export interface QuestionConnectionHandlers {
  onEvent: (event: QuestionStreamEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
}

export interface QuestionConnectionOptions extends QuestionConnectionHandlers {
  fetch?: typeof globalThis.fetch;
  url?: string;
  watchdogMs?: number;
  backoff?: BackoffOptions;
  random?: () => number;
}

class StreamEnded extends Error {}

/**
 * The reconnect loop:
 *  1. `fetch(url)`; anything but 200 + `text/event-stream` + a body is a failure (this
 *     includes the Vite proxy's 502 `text/plain` while the server restarts).
 *  2. Read with `readSse`; every read with bytes (pings included) re-arms the watchdog.
 *  3. Status `live` only after the `snapshot`, which also resets the backoff. A first event
 *     other than `snapshot` is a protocol error.
 *  4. Error / end of stream / watchdog → `reconnecting` + backoff sleep (interruptible).
 */
export function createQuestionConnection(options: QuestionConnectionOptions): QuestionConnection {
  const {
    onEvent,
    onStatus,
    url = QUESTION_EVENTS_URL,
    watchdogMs = QUESTION_EVENTS_WATCHDOG_MS,
    backoff,
    random = Math.random,
  } = options;
  // Resolved at call time, so a stubbed global `fetch` (tests) is picked up.
  const fetchImpl: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  let running = false;
  let generation = 0;
  let current: AbortController | null = null;
  let skipBackoff = false;
  let wake: (() => void) | null = null;
  let failures = 0;
  let everLive = false;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (wake === done) wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });

  async function connectOnce(controller: AbortController): Promise<void> {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(new StreamEnded('watchdog')), watchdogMs);
    };
    arm();
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
      });
      const type = res.headers.get('content-type') ?? '';
      if (res.status !== 200 || !type.includes('text/event-stream') || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new StreamEnded(`Event stream unavailable: ${res.status}`);
      }
      let gotSnapshot = false;
      for await (const sse of readSse(res.body, { onBytes: arm })) {
        // Stopped, resynced or timed out meanwhile: nothing more from this connection.
        if (controller.signal.aborted) break;
        const event = parseQuestionEvent(sse);
        if (!event) continue;
        if (!gotSnapshot && event.event !== 'snapshot')
          throw new QuestionProtocolError(`First event must be "snapshot", got "${event.event}"`);
        onEvent(event);
        if (event.event === 'snapshot' && !gotSnapshot) {
          gotSnapshot = true;
          failures = 0;
          everLive = true;
          if (running && current === controller) onStatus('live');
        }
      }
    } finally {
      clearTimeout(watchdog);
      // Closes the response even when the loop stopped reading early.
      controller.abort();
    }
  }

  async function loop(gen: number): Promise<void> {
    while (running && gen === generation) {
      onStatus(everLive || failures > 0 ? 'reconnecting' : 'connecting');
      const controller = new AbortController();
      current = controller;
      try {
        await connectOnce(controller);
      } catch {
        // Network error, abort, protocol error or watchdog: reconnect below.
      } finally {
        if (current === controller) current = null;
      }
      if (!running || gen !== generation) return;
      if (skipBackoff) {
        skipBackoff = false;
        continue;
      }
      onStatus('reconnecting');
      const delay = nextBackoff(failures, backoff, random);
      failures += 1;
      await sleep(delay);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      generation += 1;
      skipBackoff = false;
      void loop(generation);
    },
    stop() {
      if (!running) return;
      running = false;
      generation += 1;
      current?.abort();
      current = null;
      wake?.();
      onStatus('paused');
    },
    resync() {
      if (!running) return;
      skipBackoff = current !== null;
      current?.abort();
      wake?.();
    },
  };
}
