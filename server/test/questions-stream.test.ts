import { readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AttachmentStaging } from '../src/agent/index.js';
import { buildApp } from '../src/app.js';
import { exists } from '../src/storage/fs-utils.js';
import { HELD_DIR_PREFIX } from '../src/storage/index.js';
import type { MakeAppExtra } from './helpers.js';
import {
  deferred,
  type EventStream,
  expectDone,
  fakeAgent,
  makeApp,
  makeTempDir,
  multipartMessage,
  openEventStream,
  perQuestionAgent,
  postQuestion,
  type SseFrame,
  settle,
  TEST_MODELS,
  type TestContext,
  tempEntries,
  waitFor,
} from './helpers.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const saveSvg = (s: AttachmentStaging) =>
  s.saveFromBytes({ name: 'chart.svg', data: Buffer.from(svg), origin: 'inline' });

const isEvent = (name: string, id?: string) => (frame: SseFrame) =>
  frame.event === name &&
  (id === undefined ||
    ((frame.data as { id?: string; question?: { id: string } }).id ??
      (frame.data as { question?: { id: string } }).question?.id) === id);

describe('GET /api/questions/events', () => {
  let ctx: TestContext;
  let baseUrl: string;
  const streams: EventStream[] = [];
  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await ctx.close();
  });

  async function setup(agent: Agent, extra: MakeAppExtra = {}) {
    ctx = await makeApp(agent, TEST_MODELS, extra);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  }

  async function connect(query = '') {
    const stream = await openEventStream(baseUrl, query);
    streams.push(stream);
    return stream;
  }

  it('sends SSE headers, retry first, then the snapshot with instance and id', async () => {
    await setup(fakeAgent());
    const done = await settle(ctx, await postQuestion(ctx, { parentId: '', text: 'Q' }));
    const stream = await connect();
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    expect(await stream.next()).toEqual({ retry: 2000 });
    const snapshot = await stream.next();
    expect(snapshot).toEqual({
      event: 'snapshot',
      id: String(ctx.events.all.at(-1)?.seq),
      data: {
        instance: ctx.questions.instance,
        questions: [{ ...done.question, live: null }],
      },
    });
  });

  it('catches up: the snapshot has the answer so far, later chunks continue its offset', async () => {
    const gate = deferred();
    await setup(perQuestionAgent({ gates: { slow: gate.promise } }));
    const res = await postQuestion(ctx, { parentId: '', text: 'slow' });
    const { id } = res.json().question;
    await waitFor(() => ctx.events.text(id) === 'slow:1');

    const stream = await connect();
    const snapshot = await stream.next(isEvent('snapshot'));
    const [entry] = (snapshot.data as { questions: Array<{ live: unknown }> }).questions;
    expect(entry).toMatchObject({
      id,
      status: 'streaming',
      live: { attempt: 1, answer: 'slow:1' },
    });
    gate.open();
    const chunk = await stream.next(isEvent('chunk', id));
    expect(chunk.data).toEqual({ id, tree: 'rust', attempt: 1, offset: 6, text: 'slow:2' });
    expect(Number(chunk.id)).toBeGreaterThan(Number(snapshot.id));
    const naming = await stream.next(isEvent('question', id));
    expect(naming.data).toMatchObject({ question: { status: 'naming' } });
    const done = await stream.next(isEvent('question', id));
    expect(done.data).toMatchObject({ question: { status: 'done', nodeId: 'test-node' } });
  });

  it('the snapshot carries live attachments and files of a running multipart question', async () => {
    const gate = deferred();
    const saved = deferred();
    await setup(
      fakeAgent({
        chunks: ['a', 'b'],
        attachments: [
          {
            at: 0,
            save: async (s) => {
              await saveSvg(s);
              saved.open();
            },
          },
        ],
        gate: () => gate.promise,
      }),
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/questions',
      ...multipartMessage({ parentId: '', text: 'Q' }, [{ name: 'a.txt', content: 'x' }]),
    });
    const { id } = res.json().question;
    await saved.promise;
    const stream = await connect();
    const snapshot = await stream.next(isEvent('snapshot'));
    expect((snapshot.data as { questions: unknown[] }).questions).toEqual([
      expect.objectContaining({
        id,
        files: [{ name: 'a.txt', size: 1, contentType: 'text/plain; charset=utf-8', kind: 'text' }],
        live: {
          attempt: 1,
          answer: '',
          attachments: [
            {
              status: 'ready',
              key: expect.any(String),
              attachment: {
                name: 'chart.svg',
                size: svg.length,
                contentType: 'image/svg+xml',
                kind: 'svg',
                origin: 'inline',
              },
            },
          ],
        },
      }),
    ]);
    gate.open();
    expectDone(await ctx.questions.settled(id));
  });

  it('two subscribers see identical sequences', async () => {
    await setup(fakeAgent({ chunks: ['x', 'y', 'z'] }));
    const one = await connect();
    const two = await connect();
    await one.next(isEvent('snapshot'));
    await two.next(isEvent('snapshot'));
    const { started } = await settle(ctx, await postQuestion(ctx, { parentId: '', text: 'Q' }));
    const last = (frame: SseFrame) =>
      isEvent('question', started.id)(frame) &&
      (frame.data as { question: { status: string } }).question.status === 'done';
    await one.next(last);
    await two.next(last);
    expect(one.frames).toEqual(two.frames);
    expect(one.frames.filter((f) => f.event).map((f) => f.event)).toEqual([
      'snapshot',
      'question',
      'chunk',
      'chunk',
      'chunk',
      'question',
      'question',
    ]);
  });

  it('closing a stream does not affect the question', async () => {
    const gate = deferred();
    await setup(perQuestionAgent({ gates: { Q: gate.promise }, names: { Q: 'kept' } }));
    const stream = await connect();
    await stream.next(isEvent('snapshot'));
    const res = await postQuestion(ctx, { parentId: '', text: 'Q' });
    await stream.next(isEvent('chunk'));
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.open();
    expect(expectDone((await settle(ctx, res)).question).nodeId).toBe('kept');
  });

  it('?tree= filters the snapshot and the events', async () => {
    await setup(fakeAgent());
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Go' } });
    await settle(ctx, await postQuestion(ctx, { parentId: '', text: 'rust question' }));
    const go = await connect('?tree=go');
    const snapshot = await go.next(isEvent('snapshot'));
    expect((snapshot.data as { questions: unknown[] }).questions).toEqual([]);
    await settle(ctx, await postQuestion(ctx, { parentId: '', text: 'rust again' }));
    const { started } = await settle(
      ctx,
      await postQuestion(ctx, { parentId: '', text: 'go question' }, 'go'),
    );
    await go.next(
      (f) => isEvent('question', started.id)(f) && JSON.stringify(f.data).includes('"done"'),
    );
    const trees = go.frames
      .filter((f) => f.event && f.event !== 'snapshot')
      .map((f) => {
        const data = f.data as { tree?: string; question?: { tree: string } };
        return data.tree ?? data.question?.tree;
      });
    expect(new Set(trees)).toEqual(new Set(['go']));
  });

  it('sends `: ping` comments every pingIntervalMs; ignores Last-Event-ID', async () => {
    await setup(fakeAgent(), { timings: { pingIntervalMs: 30 } });
    const res = await fetch(`${baseUrl}/api/questions/events`, {
      headers: { 'last-event-id': '999' },
    });
    const reader = res.body?.getReader();
    let text = '';
    while (!text.includes(': ping\n\n')) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain('event: snapshot');
    expect(text).toContain(': ping\n\n');
    await reader?.cancel();
  });

  it('two app instances report different instance ids', async () => {
    await setup(fakeAgent());
    const other = await makeApp(fakeAgent());
    try {
      const a = await ctx.app.inject({ method: 'GET', url: '/api/questions' });
      const b = await other.app.inject({ method: 'GET', url: '/api/questions' });
      expect(a.json().instance).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.json().instance).not.toBe(b.json().instance);
    } finally {
      await other.close();
    }
  });
});

describe('shutdown', () => {
  it('app.close() ends open streams, aborts running answers and removes the owned held root', async () => {
    const temp = await makeTempDir();
    let fail = true;
    const gate = deferred();
    const agent = fakeAgent({
      onAsk: () => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
      },
      gate: () => gate.promise,
    });
    // Default question service: owned held root in the OS temp dir.
    const app = await buildApp({ treesDir: temp.dir, agent, models: TEST_MODELS });
    try {
      await app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
      const failedRes = await app.inject({
        method: 'POST',
        url: '/api/trees/rust/questions',
        ...multipartMessage({ parentId: '', text: 'Q' }, [{ name: 'a.txt', content: 'x' }]),
      });
      const failedId: string = failedRes.json().question.id;
      const owned = await waitFor(async () => {
        const roots = (await readdir(os.tmpdir())).filter((n) => n.startsWith(HELD_DIR_PREFIX));
        for (const root of roots) {
          if (await exists(path.join(os.tmpdir(), root, failedId))) return root;
        }
        return undefined;
      });
      expect(owned).toBeTruthy();

      await app.listen({ host: '127.0.0.1', port: 0 });
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const stream = await openEventStream(url);
      const snapshot = await stream.next((f) => f.event === 'snapshot');
      expect(
        (snapshot.data as { questions: Array<{ id: string }> }).questions.map((q) => q.id),
      ).toEqual([failedId]);
      const running = await app.inject({
        method: 'POST',
        url: '/api/trees/rust/questions',
        payload: { parentId: '', text: 'running' },
      });
      expect(running.statusCode).toBe(202);
      expect(await tempEntries(path.join(temp.dir, 'rust'))).toHaveLength(1);

      const start = Date.now();
      await app.close();
      expect(Date.now() - start).toBeLessThan(2000);
      await stream.waitEnded();
      expect(await tempEntries(path.join(temp.dir, 'rust'))).toEqual([]);
      expect(await readdir(path.join(temp.dir, 'rust'))).toEqual(['tree.md']);
      expect(await exists(path.join(os.tmpdir(), owned as string))).toBe(false);
    } finally {
      gate.open();
      await app.close();
      await temp.cleanup();
    }
  });
});
