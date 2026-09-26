import { mkdtemp, rm } from 'node:fs/promises';
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

export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'otago-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface FakeAgentOptions {
  chunks?: string[];
  name?: string;
  failAfter?: number;
  /** Resolves before each chunk; lets a test pause the stream. */
  gate?: () => Promise<void>;
  /** Staging calls run before chunk index `at` (`chunks.length` = after the last chunk). */
  attachments?: Array<{ at: number; save: (staging: AttachmentStaging) => Promise<unknown> }>;
  /** Runs when `ask` starts, before any chunk (e.g. to inspect the staged files). */
  onAsk?: (input: AskInput) => void | Promise<void>;
}

export function fakeAgent(
  options: FakeAgentOptions = {},
): Agent & { calls: AskInput[]; nameCalls: NameInput[] } {
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
        await options.gate?.();
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
      return options.name ?? 'test-node';
    },
  };
}

export const TEST_MODELS: ModelConfig = {
  available: ['answer-default', 'answer-alt', 'naming-default', 'naming-alt'],
  answer: 'answer-default',
  naming: 'naming-default',
};

export async function makeApp(
  agent: Agent = fakeAgent(),
  models: ModelConfig = TEST_MODELS,
  extra: { allowPrivateUrls?: boolean; locks?: TreeLocks } = {},
) {
  const temp = await makeTempDir();
  const locks = extra.locks ?? new TreeLocks();
  const app = await buildApp({ treesDir: temp.dir, agent, models, ...extra, locks });
  return {
    app,
    treesDir: temp.dir,
    locks,
    close: async () => {
      await app.close();
      await temp.cleanup();
    },
  };
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

export interface SseEvent {
  event: string;
  data: unknown;
}

export function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6) ?? 'null';
      return { event, data: JSON.parse(data) };
    });
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
