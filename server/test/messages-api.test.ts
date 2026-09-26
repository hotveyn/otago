import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AgentEvent } from '../src/agent/index.js';
import { parseNodeFile } from '../src/storage/index.js';
import { fakeAgent, makeApp, parseSse, type SseEvent } from './helpers.js';

const IDLE = { shared: 0, exclusive: false };

/**
 * Agent whose answer to question `q` streams `q:1`, then waits for `gates[q]` (if any) or
 * an abort, then streams `q:2` and finishes with `answer q`. Names come from `names[q]`.
 */
function perQuestionAgent(
  options: { gates?: Record<string, Promise<void>>; names?: Record<string, string> } = {},
): Agent {
  return {
    async *ask(input): AsyncGenerator<AgentEvent> {
      yield { type: 'chunk', text: `${input.question}:1` };
      const gate = options.gates?.[input.question];
      if (gate) {
        await Promise.race([
          gate,
          new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve())),
        ]);
      }
      if (input.signal.aborted) throw new Error('Aborted');
      yield { type: 'chunk', text: `${input.question}:2` };
      yield { type: 'done', text: `answer ${input.question}`, model: input.model };
    },
    async name(input) {
      return options.names?.[input.question] ?? 'test-node';
    },
  };
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function doneOf(events: SseEvent[]): { nodeId: string } {
  const done = events.find((event) => event.event === 'done');
  if (!done) throw new Error(`No done event in ${JSON.stringify(events)}`);
  return done.data as { nodeId: string };
}

describe('POST /api/trees/:tree/messages', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  afterEach(() => ctx.close());

  async function setup(agent: Agent) {
    ctx = await makeApp(agent);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/trees',
      payload: { title: 'Rust', instructions: 'Be brief.' },
    });
    return ctx;
  }

  const post = (payload: object, tree = 'rust') =>
    ctx.app.inject({ method: 'POST', url: `/api/trees/${tree}/messages`, payload });

  const treeEntries = async () => (await readdir(path.join(ctx.treesDir, 'rust'))).sort();

  it('streams chunks, writes the node and returns its id', async () => {
    const agent = fakeAgent({ chunks: ['Borrowing ', 'is ', 'referencing.'], name: 'borrowing' });
    await setup(agent);

    const res = await post({ parentId: '', text: 'What is borrowing?' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(parseSse(res.body)).toEqual([
      { event: 'chunk', data: 'Borrowing ' },
      { event: 'chunk', data: 'is ' },
      { event: 'chunk', data: 'referencing.' },
      { event: 'done', data: { nodeId: 'borrowing', attachments: [], files: [] } },
    ]);

    const node = parseNodeFile(
      await readFile(path.join(ctx.treesDir, 'rust', 'borrowing', 'node.md'), 'utf8'),
    );
    expect(node).toMatchObject({
      model: 'answer-default',
      user: 'What is borrowing?',
      assistant: 'Borrowing is referencing.',
    });
    expect(agent.calls[0]).toMatchObject({
      instructions: 'Be brief.',
      chain: [],
      question: 'What is borrowing?',
    });
    expect(agent.calls[0]?.treeDir).toBe(path.join(ctx.treesDir, 'rust'));
  });

  it('uses default models when none are given', async () => {
    const agent = fakeAgent();
    await setup(agent);
    await post({ parentId: '', text: 'Q' });
    expect(agent.calls[0]?.model).toBe('answer-default');
    expect(agent.nameCalls[0]).toMatchObject({ question: 'Q', model: 'naming-default' });
  });

  it('uses the requested answer and naming models and records the answer model', async () => {
    const agent = fakeAgent({ name: 'picked' });
    await setup(agent);
    const res = await post({
      parentId: '',
      text: 'Q',
      model: 'answer-alt',
      namingModel: 'naming-alt',
    });
    expect(parseSse(res.body).at(-1)).toEqual({
      event: 'done',
      data: { nodeId: 'picked', attachments: [], files: [] },
    });
    expect(agent.calls[0]?.model).toBe('answer-alt');
    expect(agent.nameCalls[0]?.model).toBe('naming-alt');
    const file = await readFile(path.join(ctx.treesDir, 'rust', 'picked', 'node.md'), 'utf8');
    expect(parseNodeFile(file).model).toBe('answer-alt');
  });

  it('400 for a model outside the allowlist, lock untouched', async () => {
    const agent = fakeAgent();
    await setup(agent);
    const badAnswer = await post({ parentId: '', text: 'Q', model: 'gpt-4' });
    expect(badAnswer.statusCode).toBe(400);
    expect(badAnswer.json().error).toContain('Unknown model "gpt-4"');
    expect((await post({ parentId: '', text: 'Q', namingModel: 'nope' })).statusCode).toBe(400);
    expect(agent.calls).toEqual([]);
    expect((await post({ parentId: '', text: 'Q' })).statusCode).toBe(200);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('creates a child and passes the chain to the agent', async () => {
    const agent = fakeAgent({ name: 'topic' });
    await setup(agent);
    await post({ parentId: '', text: 'Q1' });
    const res = await post({ parentId: 'topic', text: 'Q2' });
    expect(parseSse(res.body).at(-1)).toEqual({
      event: 'done',
      data: { nodeId: 'topic/topic', attachments: [], files: [] },
    });
    expect(agent.calls[1]?.chain).toMatchObject([{ user: 'Q1', assistant: 'Hello, world' }]);
  });

  it('falls back to a name from the question when naming fails', async () => {
    const agent = fakeAgent();
    agent.name = async () => {
      throw new Error('haiku down');
    };
    await setup(agent);
    const res = await post({ parentId: '', text: 'What is ownership in Rust?' });
    expect(parseSse(res.body).at(-1)).toEqual({
      event: 'done',
      data: { nodeId: 'what-is-ownership-in', attachments: [], files: [] },
    });
  });

  it('runner error → error event, no folder created, lock released', async () => {
    await setup(fakeAgent({ chunks: ['partial', 'more'], failAfter: 1 }));
    const res = await post({ parentId: '', text: 'Q' });
    expect(parseSse(res.body)).toEqual([
      { event: 'chunk', data: 'partial' },
      { event: 'error', data: { message: 'Agent exploded' } },
    ]);
    expect(await treeEntries()).toEqual(['tree.md']);

    expect(ctx.locks.status('rust')).toEqual(IDLE);
    const again = await post({ parentId: '', text: 'Q' });
    expect(again.statusCode).toBe(200);
  });

  it('400 on invalid body, 404 on unknown tree or parent', async () => {
    await setup(fakeAgent());
    expect((await post({ parentId: '', text: '   ' })).statusCode).toBe(400);
    expect((await post({ text: 'Q' })).statusCode).toBe(400);
    expect((await post({ parentId: '../x', text: 'Q' })).statusCode).toBe(400);
    expect((await post({ parentId: 'missing', text: 'Q' })).statusCode).toBe(404);
    expect((await post({ parentId: '', text: 'Q' }, 'nope')).statusCode).toBe(404);
    // Failed validation must not leave the lock held.
    expect(ctx.locks.status('rust')).toEqual(IDLE);
    expect((await post({ parentId: '', text: 'Q' })).statusCode).toBe(200);
  });

  it('two streams in the same tree run concurrently from the same parent', async () => {
    const gate = deferred();
    await setup(perQuestionAgent({ gates: { Q1: gate.promise, Q2: gate.promise } }));
    const first = post({ parentId: '', text: 'Q1' });
    const second = post({ parentId: '', text: 'Q2' });
    await tick();
    expect(ctx.locks.status('rust')).toEqual({ shared: 2, exclusive: false });
    gate.open();

    const results = await Promise.all([first, second]);
    const ids: string[] = [];
    for (const [index, res] of results.entries()) {
      expect(res.statusCode).toBe(200);
      const { nodeId } = doneOf(parseSse(res.body));
      ids.push(nodeId);
      const file = await readFile(path.join(ctx.treesDir, 'rust', nodeId, 'node.md'), 'utf8');
      expect(parseNodeFile(file)).toMatchObject({
        user: `Q${index + 1}`,
        assistant: `answer Q${index + 1}`,
      });
    }
    expect([...ids].sort()).toEqual(['test-node', 'test-node-2']);
    expect(await treeEntries()).toEqual(['test-node', 'test-node-2', 'tree.md']);
    expect(ctx.locks.isLocked('rust')).toBe(false);
  });

  it('streams from different parents (main and side) run concurrently', async () => {
    const gate = deferred();
    await setup(
      perQuestionAgent({
        gates: { main: gate.promise, side: gate.promise },
        names: { A: 'a', B: 'b', main: 'main', side: 'side' },
      }),
    );
    await post({ parentId: '', text: 'A' });
    await post({ parentId: 'a', text: 'B' });
    const main = post({ parentId: 'a', text: 'main' });
    const side = post({ parentId: 'a/b', text: 'side' });
    await tick();
    expect(ctx.locks.status('rust').shared).toBe(2);
    gate.open();
    const [mainRes, sideRes] = await Promise.all([main, side]);
    expect(doneOf(parseSse(mainRes.body)).nodeId).toBe('a/main');
    expect(doneOf(parseSse(sideRes.body)).nodeId).toBe('a/b/side');
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('move/delete during a stream → 409 tree_busy_streaming, then 200 after it', async () => {
    const gate = deferred();
    await setup(perQuestionAgent({ gates: { slow: gate.promise }, names: { first: 'first' } }));
    await post({ parentId: '', text: 'first' });
    const stream = post({ parentId: 'first', text: 'slow' });
    await tick();

    const del = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/trees/rust/nodes/delete',
        payload: { ids: ['first'] },
      });
    const busyDelete = await del();
    expect(busyDelete.statusCode).toBe(409);
    expect(busyDelete.json().code).toBe('tree_busy_streaming');
    const busyMove = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/move',
      payload: { ids: ['first'], targetParentId: '' },
    });
    expect(busyMove.statusCode).toBe(409);
    expect(busyMove.json().code).toBe('tree_busy_streaming');

    gate.open();
    const res = await stream;
    expect(doneOf(parseSse(res.body)).nodeId).toBe('first/test-node');
    expect((await del()).statusCode).toBe(200);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('stream while a move/delete holds the tree → 409 tree_busy_structural, no SSE', async () => {
    const agent = fakeAgent();
    await setup(agent);
    const release = ctx.locks.acquireExclusive('rust');
    const res = await post({ parentId: '', text: 'Q' });
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({
      error: 'Tree "rust" is busy: nodes are being moved or deleted. Try again in a moment.',
      code: 'tree_busy_structural',
    });
    expect(agent.calls).toEqual([]);
    expect(await treeEntries()).toEqual(['tree.md']);
    release();
    expect((await post({ parentId: '', text: 'Q' })).statusCode).toBe(200);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('one stream aborted, the other completes', async () => {
    const gate = deferred();
    await setup(
      perQuestionAgent({
        gates: { aborted: new Promise<void>(() => {}), kept: gate.promise },
        names: { aborted: 'aborted', kept: 'kept' },
      }),
    );
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;

    const controller = new AbortController();
    const abortedRes = await fetch(`http://127.0.0.1:${port}/api/trees/rust/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: '', text: 'aborted' }),
      signal: controller.signal,
    });
    expect(abortedRes.status).toBe(200);
    const kept = post({ parentId: '', text: 'kept' });
    await tick();
    expect(ctx.locks.status('rust').shared).toBe(2);
    controller.abort();
    await tick(100);
    gate.open();

    const res = await kept;
    expect(doneOf(parseSse(res.body)).nodeId).toBe('kept');
    await tick(100);
    expect(await treeEntries()).toEqual(['kept', 'tree.md']);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('404 when the parent was deleted between turns', async () => {
    await setup(perQuestionAgent({ names: { anchor: 'anchor' } }));
    await post({ parentId: '', text: 'anchor' });
    const deleted = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/delete',
      payload: { ids: ['anchor'] },
    });
    expect(deleted.statusCode).toBe(200);
    const res = await post({ parentId: 'anchor', text: 'follow-up' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Node not found: anchor' });
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('client disconnect → nothing written, lock released', async () => {
    let chunksSent = 0;
    let firstChunkSent!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkSent = resolve;
    });
    await setup(
      fakeAgent({
        chunks: ['a', 'b', 'c'],
        gate: async () => {
          if (chunksSent++ === 1) firstChunkSent();
          if (chunksSent > 1) await new Promise((resolve) => setTimeout(resolve, 50));
        },
      }),
    );
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/trees/rust/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: '', text: 'Q' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    await firstChunk;
    controller.abort();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await treeEntries()).toEqual(['tree.md']);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
    const again = await post({ parentId: '', text: 'Q' });
    expect(again.statusCode).toBe(200);
  });
});
