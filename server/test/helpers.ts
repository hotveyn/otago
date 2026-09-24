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
  extra: { allowPrivateUrls?: boolean } = {},
) {
  const temp = await makeTempDir();
  const app = await buildApp({ treesDir: temp.dir, agent, models, ...extra });
  return {
    app,
    treesDir: temp.dir,
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
