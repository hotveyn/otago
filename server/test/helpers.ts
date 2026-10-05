import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Agent,
  AgentEvent,
  AskInput,
  AttachmentStaging,
  NameInput,
} from '../src/agent/index.js';
import { TreeLocks } from '../src/agent/index.js';
import { buildApp } from '../src/app.js';
import type { ModelConfig } from '../src/config.js';
import {
  type DoneQuestion,
  type FailedQuestion,
  type QuestionHooks,
  type QuestionInfo,
  Questions,
  type QuestionTimings,
  type RegistryEvent,
} from '../src/questions/index.js';

export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'otago-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it returns a truthy value (or throw after `timeoutMs`). */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await tick(5);
  }
}

/** `promise`, or a rejection with `Aborted` as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export interface FakeAgentOptions {
  chunks?: string[];
  name?: string;
  failAfter?: number;
  /** Awaited before each chunk (raced with the abort signal); lets a test pause the stream. */
  gate?: () => Promise<void>;
  /** Staging calls run before chunk index `at` (`chunks.length` = after the last chunk). */
  attachments?: Array<{ at: number; save: (staging: AttachmentStaging) => Promise<unknown> }>;
  /** Runs when `ask` starts, before any chunk (e.g. to inspect the staged files). */
  onAsk?: (input: AskInput) => void | Promise<void>;
  /** Awaited by `name` (raced with its signal). */
  nameGate?: (input: NameInput) => Promise<void>;
  /** `name` throws this message. */
  nameError?: string;
}

export type FakeAgent = Agent & { calls: AskInput[]; nameCalls: NameInput[] };

export function fakeAgent(options: FakeAgentOptions = {}): FakeAgent {
  const chunks = options.chunks ?? ['Hello', ', world'];
  const calls: AskInput[] = [];
  const nameCalls: NameInput[] = [];
  return {
    calls,
    nameCalls,
    async *ask(input): AsyncGenerator<AgentEvent> {
      calls.push(input);
      await options.onAsk?.(input);
      let text = '';
      // Like the real tool: a failed save is reported to the agent, the answer continues.
      const saveAt = async (index: number) => {
        for (const item of options.attachments ?? []) {
          if (item.at === index) await item.save(input.staging).catch(() => undefined);
        }
      };
      for (const [index, chunk] of chunks.entries()) {
        await saveAt(index);
        if (options.failAfter === index) throw new Error('Agent exploded');
        if (options.gate) await raceAbort(options.gate(), input.signal);
        if (input.signal.aborted) throw new Error('Aborted');
        text += chunk;
        yield { type: 'chunk', text: chunk };
      }
      await saveAt(chunks.length);
      if (options.failAfter === chunks.length) throw new Error('Agent exploded');
      yield { type: 'done', text, model: input.model };
    },
    async name(input) {
      nameCalls.push(input);
      if (options.nameGate) await raceAbort(options.nameGate(input), input.signal);
      if (options.nameError) throw new Error(options.nameError);
      return options.name ?? 'test-node';
    },
  };
}

/**
 * Agent whose answer to question `q` streams `q:1`, then waits for `gates[q]` (if any) or
 * an abort, then streams `q:2` and finishes with `answer q`. Names come from `names[q]`.
 */
export function perQuestionAgent(
  options: { gates?: Record<string, Promise<void>>; names?: Record<string, string> } = {},
): FakeAgent {
  const calls: AskInput[] = [];
  const nameCalls: NameInput[] = [];
  return {
    calls,
    nameCalls,
    async *ask(input): AsyncGenerator<AgentEvent> {
      calls.push(input);
      yield { type: 'chunk', text: `${input.question}:1` };
      const gate = options.gates?.[input.question];
      if (gate) await raceAbort(gate, input.signal);
      if (input.signal.aborted) throw new Error('Aborted');
      yield { type: 'chunk', text: `${input.question}:2` };
      yield { type: 'done', text: `answer ${input.question}`, model: input.model };
    },
    async name(input) {
      nameCalls.push(input);
      return options.names?.[input.question] ?? 'test-node';
    },
  };
}

export const TEST_MODELS: ModelConfig = {
  available: ['answer-default', 'answer-alt', 'naming-default', 'naming-alt'],
  answer: 'answer-default',
  naming: 'naming-default',
};

export interface MakeAppExtra {
  allowPrivateUrls?: boolean;
  locks?: TreeLocks;
  timings?: Partial<QuestionTimings>;
  hooks?: QuestionHooks;
}

/** Records every registry event from creation on (an in-process subscriber). */
export interface EventRecorder {
  readonly all: RegistryEvent[];
  forQuestion(id: string): RegistryEvent[];
  /** Concatenated chunk texts of `id` (optionally of one attempt). */
  text(id: string, attempt?: number): string;
  stop(): void;
}

export function questionIdOf(event: RegistryEvent): string {
  return event.event === 'question' ? event.data.question.id : event.data.id;
}

export function recordEvents(questions: Questions): EventRecorder {
  const all: RegistryEvent[] = [];
  const { unsubscribe } = questions.subscribe({
    onEvent: (event) => all.push(event),
    onEnd: () => undefined,
  });
  return {
    all,
    forQuestion: (id) => all.filter((event) => questionIdOf(event) === id),
    text: (id, attempt) =>
      all
        .flatMap((event) =>
          event.event === 'chunk' &&
          event.data.id === id &&
          (attempt === undefined || event.data.attempt === attempt)
            ? [event.data.text]
            : [],
        )
        .join(''),
    stop: unsubscribe,
  };
}

/**
 * Compact event names: `question:<status>`, `chunk`, `attachment:<status>`, `removed:<reason>`.
 */
export function eventKinds(events: RegistryEvent[]): string[] {
  return events.map((event) => {
    switch (event.event) {
      case 'question':
        return `question:${event.data.question.status}`;
      case 'attachment':
        return `attachment:${event.data.event.status}`;
      case 'removed':
        return `removed:${event.data.reason}`;
      default:
        return event.event;
    }
  });
}

export async function makeApp(
  agent: Agent = fakeAgent(),
  models: ModelConfig = TEST_MODELS,
  extra: MakeAppExtra = {},
) {
  const temp = await makeTempDir();
  const held = await makeTempDir();
  const locks = extra.locks ?? new TreeLocks();
  const allowPrivateUrls = extra.allowPrivateUrls ?? false;
  const questions = new Questions({
    agent,
    locks,
    treesDir: temp.dir,
    allowPrivateUrls,
    heldDir: held.dir,
    timings: extra.timings,
    hooks: extra.hooks,
  });
  const events = recordEvents(questions);
  const app = await buildApp({
    treesDir: temp.dir,
    agent,
    models,
    locks,
    allowPrivateUrls,
    questions,
  });
  return {
    app,
    treesDir: temp.dir,
    heldDir: held.dir,
    locks,
    questions,
    events,
    close: async () => {
      await app.close();
      events.stop();
      await temp.cleanup();
      await held.cleanup();
    },
  };
}

export type TestContext = Awaited<ReturnType<typeof makeApp>>;

export function postQuestion(ctx: TestContext, body: object, tree = 'rust') {
  return ctx.app.inject({ method: 'POST', url: `/api/trees/${tree}/questions`, payload: body });
}

export interface Settled {
  /** The 202 response. */
  res: Awaited<ReturnType<TestContext['app']['inject']>>;
  /** `question` of the 202 body. */
  started: QuestionInfo;
  /** Terminal state (`undefined` when the question was removed). */
  question: QuestionInfo | undefined;
  /** Every event of the question so far. */
  events: RegistryEvent[];
}

/** Expect a 202 and wait until the question is done, failed or removed. */
export async function settle(ctx: TestContext, res: Settled['res']): Promise<Settled> {
  if (res.statusCode !== 202) throw new Error(`Expected 202, got ${res.statusCode}: ${res.body}`);
  const started = res.json().question as QuestionInfo;
  const question = await ctx.questions.settled(started.id);
  return { res, started, question, events: ctx.events.forQuestion(started.id) };
}

/** POST a JSON question, expect 202 and wait for its outcome. */
export async function askAndSettle(ctx: TestContext, body: object, tree = 'rust') {
  return settle(ctx, await postQuestion(ctx, body, tree));
}

export function expectDone(question: QuestionInfo | undefined): DoneQuestion {
  if (question?.status !== 'done') {
    throw new Error(`Expected a done question, got ${JSON.stringify(question)}`);
  }
  return question;
}

export function expectFailed(question: QuestionInfo | undefined): FailedQuestion {
  if (question?.status !== 'failed') {
    throw new Error(`Expected a failed question, got ${JSON.stringify(question)}`);
  }
  return question;
}

/** Every `.tmp-*` entry anywhere under `dir`. */
export async function tempEntries(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.tmp-')) found.push(entry.name);
    else if (entry.isDirectory()) found.push(...(await tempEntries(path.join(dir, entry.name))));
  }
  return found;
}

export function multipartBody(field: string, filename: string, content: string | Uint8Array) {
  const boundary = `----otago${Math.random().toString(16).slice(2)}`;
  const head = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${field}"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    '',
  ].join('\r\n');
  const payload = Buffer.concat([
    Buffer.from(head),
    typeof content === 'string' ? Buffer.from(content) : content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** One SSE block: an event (`event`/`data`/`id`), a `retry:` line or a comment. */
export interface SseFrame {
  event?: string;
  data?: unknown;
  id?: string;
  retry?: number;
  comment?: string;
}

export function parseSseBlock(block: string): SseFrame {
  const frame: SseFrame = {};
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim();
    else if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
    else if (line.startsWith('retry: ')) frame.retry = Number(line.slice(7));
  }
  if (data.length > 0) frame.data = JSON.parse(data.join('\n'));
  return frame;
}

/** Parse a whole SSE body (blocks separated by a blank line). */
export function parseSse(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim())
    .map(parseSseBlock);
}

export interface EventStream {
  status: number;
  headers: Headers;
  /** Every frame received so far, in order. */
  frames: SseFrame[];
  /** True once the server ended (or dropped) the stream. */
  readonly ended: boolean;
  /** Next frame after the previous `next` match that satisfies `predicate`. */
  next(predicate?: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  /** Wait until the server ends the stream. */
  waitEnded(timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Open `GET /api/questions/events` with `fetch` and parse it incrementally. */
export async function openEventStream(baseUrl: string, query = ''): Promise<EventStream> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/questions/events${query}`, {
    signal: controller.signal,
  });
  const frames: SseFrame[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  let ended = false;
  let cursor = 0;

  void (async () => {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let index = buffer.indexOf('\n\n'); index !== -1; index = buffer.indexOf('\n\n')) {
          frames.push(parseSseBlock(buffer.slice(0, index)));
          buffer = buffer.slice(index + 2);
        }
        notify();
      }
    } catch {
      // Aborted by `close()` or dropped by the server.
    } finally {
      ended = true;
      notify();
    }
  })();

  const waitUntil = <T>(check: () => T | undefined, timeoutMs: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const attempt = () => {
        let value: T | undefined;
        try {
          value = check();
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (value === undefined) return;
        cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${what}: timed out; frames: ${JSON.stringify(frames)}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(listener);
      };
      const listener = () => attempt();
      listeners.add(listener);
      attempt();
    });

  return {
    status: res.status,
    headers: res.headers,
    frames,
    get ended() {
      return ended;
    },
    next(predicate = () => true, timeoutMs = 2000) {
      return waitUntil(
        () => {
          for (let index = cursor; index < frames.length; index++) {
            const frame = frames[index];
            if (frame && predicate(frame)) {
              cursor = index + 1;
              return frame;
            }
          }
          if (ended) throw new Error(`Stream ended; frames: ${JSON.stringify(frames)}`);
          return undefined;
        },
        timeoutMs,
        'next',
      );
    },
    waitEnded(timeoutMs = 2000) {
      return waitUntil(() => (ended ? true : undefined), timeoutMs, 'waitEnded').then(
        () => undefined,
      );
    },
    close() {
      controller.abort();
    },
  };
}

export interface MultipartFileSpec {
  name: string;
  content: string | Uint8Array;
  type?: string;
  /** Form field name; default `files`. */
  field?: string;
}

/**
 * Raw multipart body of a message: a `payload` field (JSON-encoded unless a string is given;
 * omitted when `null`), then the files.
 */
export function multipartMessage(
  payload: object | string | null,
  files: MultipartFileSpec[],
  opts: {
    payloadLast?: boolean;
    payloadField?: string;
    extraField?: [string, string];
    /** Content-Type of the payload part (e.g. `application/json`). */
    payloadType?: string;
  } = {},
) {
  const boundary = `----otago${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  const field = (name: string, value: string, type?: string) => {
    const typeLine = type ? `Content-Type: ${type}\r\n` : '';
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n${typeLine}\r\n${value}\r\n`,
      ),
    );
  };
  const payloadPart = () => {
    if (payload === null) return;
    field(
      opts.payloadField ?? 'payload',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      opts.payloadType,
    );
  };
  if (!opts.payloadLast) payloadPart();
  if (opts.extraField) field(...opts.extraField);
  for (const file of files) {
    chunks.push(
      Buffer.from(
        [
          `--${boundary}`,
          `Content-Disposition: form-data; name="${file.field ?? 'files'}"; filename="${file.name}"`,
          `Content-Type: ${file.type ?? 'application/octet-stream'}`,
          '',
          '',
        ].join('\r\n'),
      ),
      typeof file.content === 'string' ? Buffer.from(file.content) : Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  if (opts.payloadLast) payloadPart();
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** A valid 1×1 PNG. */
export function pngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** A minimal valid FB2 book. */
export function fb2Book(title = 'Tiny Book', text = 'Borrowing is referencing.'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info><book-title>${title}</book-title></title-info></description>
  <body><section><p>${text}</p></section></body>
</FictionBook>`;
}
