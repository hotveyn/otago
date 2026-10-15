import { readdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AgentEvent, AskInput, NameInput } from '../src/agent/index.js';
import { parseNodeFile } from '../src/storage/index.js';
import type { MakeAppExtra } from './helpers.js';
import {
  askAndSettle,
  deferred,
  eventKinds,
  expectDone,
  expectFailed,
  fakeAgent,
  makeApp,
  perQuestionAgent,
  postQuestion,
  settle,
  TEST_MODELS,
  type TestContext,
  tempEntries,
  waitFor,
} from './helpers.js';

const IDLE = { shared: 0, exclusive: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STREAMING_BUSY =
  'Tree "rust" is busy: an answer is still streaming. Try again when it finishes.';

/** Agent that fails (after one chunk) on its first `failures` calls, then answers. */
function flakyAgent(failures = 1, name = 'recovered') {
  const calls: AskInput[] = [];
  const nameCalls: NameInput[] = [];
  const agent: Agent & { calls: AskInput[]; nameCalls: NameInput[] } = {
    calls,
    nameCalls,
    async *ask(input): AsyncGenerator<AgentEvent> {
      calls.push(input);
      yield { type: 'chunk', text: `try ${calls.length}` };
      if (calls.length <= failures) throw new Error('Agent exploded');
      yield { type: 'done', text: `try ${calls.length}`, model: input.model };
    },
    async name(input) {
      nameCalls.push(input);
      return name;
    },
  };
  return agent;
}

describe('POST /api/trees/:tree/questions', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  async function setup(agent: Agent, extra: MakeAppExtra = {}) {
    ctx = await makeApp(agent, TEST_MODELS, extra);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/trees',
      payload: { title: 'Rust', instructions: 'Be brief.' },
    });
    return ctx;
  }

  const post = (payload: object, tree = 'rust') => postQuestion(ctx, payload, tree);
  const treeDir = () => path.join(ctx.treesDir, 'rust');
  const treeEntries = async () => (await readdir(treeDir())).sort();
  const del = (id: string) => ctx.app.inject({ method: 'DELETE', url: `/api/questions/${id}` });
  const retry = (id: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/questions/${id}/retry` });
  const getQuestion = (id: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/questions/${id}` });

  it('202 with the question, then streams, names and commits the node', async () => {
    const agent = fakeAgent({ chunks: ['Borrowing ', 'is ', 'referencing.'], name: 'borrowing' });
    await setup(agent);

    const res = await post({ parentId: '', text: 'What is borrowing?' });
    expect(res.statusCode).toBe(202);
    const started = res.json().question;
    expect(res.headers.location).toBe(`/api/questions/${started.id}`);
    expect(started).toEqual({
      id: expect.stringMatching(UUID),
      tree: 'rust',
      parentId: '',
      context: { kind: 'main' },
      text: 'What is borrowing?',
      title: 'What is borrowing?',
      files: [],
      model: 'answer-default',
      namingModel: 'naming-default',
      attempt: 1,
      status: 'streaming',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const { question, events } = await settle(ctx, res);
    expect(eventKinds(events)).toEqual([
      'question:streaming',
      'chunk',
      'chunk',
      'chunk',
      'question:naming',
      'question:done',
    ]);
    expect(events.filter((e) => e.event === 'chunk').map((e) => e.data)).toEqual([
      { id: started.id, tree: 'rust', attempt: 1, offset: 0, text: 'Borrowing ' },
      { id: started.id, tree: 'rust', attempt: 1, offset: 10, text: 'is ' },
      { id: started.id, tree: 'rust', attempt: 1, offset: 13, text: 'referencing.' },
    ]);
    // Strictly increasing sequence numbers.
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(question).toEqual({
      ...started,
      status: 'done',
      nodeId: 'borrowing',
      attachments: [],
      files: [],
      updatedAt: expect.any(String),
    });

    const node = parseNodeFile(
      await readFile(path.join(treeDir(), 'borrowing', 'node.md'), 'utf8'),
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
      files: [],
    });
    expect(agent.calls[0]?.treeDir).toBe(treeDir());
    expect(path.basename(agent.calls[0]?.stagingDir ?? '')).toMatch(/^\.tmp-answer-/);
    expect(await tempEntries(treeDir())).toEqual([]);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('uses default models when none are given', async () => {
    const agent = fakeAgent();
    await setup(agent);
    await askAndSettle(ctx, { parentId: '', text: 'Q' });
    expect(agent.calls[0]?.model).toBe('answer-default');
    expect(agent.nameCalls[0]).toMatchObject({ question: 'Q', model: 'naming-default' });
  });

  it('uses the requested answer and naming models and records the answer model', async () => {
    const agent = fakeAgent({ name: 'picked' });
    await setup(agent);
    const { question } = await askAndSettle(ctx, {
      parentId: '',
      text: 'Q',
      model: 'answer-alt',
      namingModel: 'naming-alt',
    });
    expect(expectDone(question)).toMatchObject({
      nodeId: 'picked',
      model: 'answer-alt',
      namingModel: 'naming-alt',
    });
    expect(agent.calls[0]?.model).toBe('answer-alt');
    expect(agent.nameCalls[0]?.model).toBe('naming-alt');
    const file = await readFile(path.join(treeDir(), 'picked', 'node.md'), 'utf8');
    expect(parseNodeFile(file).model).toBe('answer-alt');
  });

  it('400 for a model outside the allowlist: no entry, lock untouched', async () => {
    const agent = fakeAgent();
    await setup(agent);
    const badAnswer = await post({ parentId: '', text: 'Q', model: 'gpt-4' });
    expect(badAnswer.statusCode).toBe(400);
    expect(badAnswer.json().error).toContain('Unknown model "gpt-4"');
    expect((await post({ parentId: '', text: 'Q', namingModel: 'nope' })).statusCode).toBe(400);
    expect(agent.calls).toEqual([]);
    expect(ctx.questions.list()).toEqual([]);
    expect(ctx.events.all).toEqual([]);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
    await askAndSettle(ctx, { parentId: '', text: 'Q' });
  });

  it('creates a child and passes the chain to the agent', async () => {
    const agent = fakeAgent({ name: 'topic' });
    await setup(agent);
    await askAndSettle(ctx, { parentId: '', text: 'Q1' });
    const { question } = await askAndSettle(ctx, { parentId: 'topic', text: 'Q2' });
    expect(expectDone(question)).toMatchObject({ parentId: 'topic', nodeId: 'topic/topic' });
    expect(agent.calls[1]?.chain).toMatchObject([{ user: 'Q1', assistant: 'Hello, world' }]);
  });

  it('names the node after the answer, from the question and the full answer', async () => {
    const order: string[] = [];
    const agent = fakeAgent({
      chunks: ['Ownership ', 'moves values.'],
      gate: async () => {
        order.push('chunk');
      },
      nameGate: async () => {
        order.push('name');
      },
    });
    await setup(agent);
    await askAndSettle(ctx, { parentId: '', text: 'What is ownership?' });
    expect(order).toEqual(['chunk', 'chunk', 'name']);
    expect(agent.nameCalls).toHaveLength(1);
    expect(agent.nameCalls[0]).toMatchObject({
      question: 'What is ownership?',
      answer: 'Ownership moves values.',
      model: 'naming-default',
    });
  });

  it('falls back to a name from the question when naming fails', async () => {
    await setup(fakeAgent({ nameError: 'haiku down' }));
    const { question } = await askAndSettle(ctx, {
      parentId: '',
      text: 'What is ownership in Rust?',
    });
    expect(expectDone(question).nodeId).toBe('what-is-ownership-in');
  });

  it('falls back in the question’s own script (Cyrillic) when naming fails', async () => {
    await setup(fakeAgent({ nameError: 'down' }));
    const { question } = await askAndSettle(ctx, { parentId: '', text: 'Что такое владение?' });
    expect(expectDone(question).nodeId).toBe('что-такое-владение');
    expect(await treeEntries()).toEqual(['tree.md', 'что-такое-владение']);
  });

  it('naming timeout → fallback name, the answer is kept', async () => {
    await setup(fakeAgent({ nameGate: () => new Promise(() => {}) }), {
      timings: { namingTimeoutMs: 30 },
    });
    const { question } = await askAndSettle(ctx, { parentId: '', text: 'Slow naming' });
    expect(expectDone(question).nodeId).toBe('slow-naming');
  });

  it('agent failure → failed{agent_error}, partial answer kept, nothing written', async () => {
    await setup(fakeAgent({ chunks: ['partial', 'more'], failAfter: 1 }));
    const { question, events } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    const failed = expectFailed(question);
    expect(failed.error).toEqual({ message: 'Agent exploded', code: 'agent_error' });
    expect(eventKinds(events)).toEqual(['question:streaming', 'chunk', 'question:failed']);
    expect(ctx.questions.detail(failed.id)?.live).toEqual({
      attempt: 1,
      answer: 'partial',
      attachments: [],
    });
    expect(await treeEntries()).toEqual(['tree.md']);
    expect(await tempEntries(treeDir())).toEqual([]);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
    // Nothing held: the question had no files.
    expect(await readdir(ctx.heldDir)).toEqual([]);
  });

  it('400 on invalid body, 404 on unknown tree or parent; nothing registered', async () => {
    await setup(fakeAgent());
    expect((await post({ parentId: '', text: '   ' })).statusCode).toBe(400);
    expect((await post({ text: 'Q' })).statusCode).toBe(400);
    expect((await post({ parentId: '../x', text: 'Q' })).statusCode).toBe(400);
    const parent = await post({ parentId: 'missing', text: 'Q' });
    expect(parent.statusCode).toBe(404);
    expect(parent.json()).toEqual({
      error: 'Parent node not found: missing',
      code: 'parent_not_found',
    });
    const tree = await post({ parentId: '', text: 'Q' }, 'nope');
    expect(tree.statusCode).toBe(404);
    expect(tree.json().code).toBe('tree_not_found');
    expect(ctx.questions.list()).toEqual([]);
    // Failed validation must not leave the lock held.
    expect(ctx.locks.status('rust')).toEqual(IDLE);
    expect(await tempEntries(treeDir())).toEqual([]);
    await askAndSettle(ctx, { parentId: '', text: 'Q' });
  });

  it('echoes the context; defaults to main; 400 for a side anchor outside the parent chain', async () => {
    await setup(perQuestionAgent({ names: { A: 'a', B: 'b' } }));
    await askAndSettle(ctx, { parentId: '', text: 'A' });
    await askAndSettle(ctx, { parentId: 'a', text: 'B' });

    const side = await askAndSettle(ctx, {
      parentId: 'a/b',
      text: 'aside',
      context: { kind: 'side', anchor: 'a' },
    });
    expect(side.started.context).toEqual({ kind: 'side', anchor: 'a' });
    expect(expectDone(side.question).context).toEqual({ kind: 'side', anchor: 'a' });
    const self = await askAndSettle(ctx, {
      parentId: 'a',
      text: 'self',
      context: { kind: 'side', anchor: 'a' },
    });
    expect(self.started.context).toEqual({ kind: 'side', anchor: 'a' });
    const root = await askAndSettle(ctx, {
      parentId: 'a',
      text: 'root',
      context: { kind: 'side', anchor: '' },
    });
    expect(root.started.context).toEqual({ kind: 'side', anchor: '' });

    for (const context of [
      { kind: 'side', anchor: 'a/b' },
      { kind: 'side', anchor: 'ab' },
      { kind: 'side', anchor: 'other' },
    ]) {
      const res = await post({ parentId: 'a', text: 'Q', context });
      expect(res.statusCode, JSON.stringify(context)).toBe(400);
    }
    expect((await post({ parentId: 'a', text: 'Q', context: { kind: 'x' } })).statusCode).toBe(400);
    expect((await post({ parentId: 'a', text: 'Q', context: { kind: 'side' } })).statusCode).toBe(
      400,
    );
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('two questions under the same parent run concurrently into distinct nodes', async () => {
    const gate = deferred();
    await setup(perQuestionAgent({ gates: { Q1: gate.promise, Q2: gate.promise } }));
    const first = await post({ parentId: '', text: 'Q1' });
    const second = await post({ parentId: '', text: 'Q2' });
    expect(ctx.locks.status('rust')).toEqual({ shared: 2, exclusive: false });
    expect(ctx.locks.holders('rust').sort()).toEqual(
      [first.json().question.id, second.json().question.id].sort(),
    );
    gate.open();

    const ids: string[] = [];
    for (const [index, res] of [first, second].entries()) {
      const { question } = await settle(ctx, res);
      const { nodeId } = expectDone(question);
      ids.push(nodeId);
      const file = await readFile(path.join(treeDir(), nodeId, 'node.md'), 'utf8');
      expect(parseNodeFile(file)).toMatchObject({
        user: `Q${index + 1}`,
        assistant: `answer Q${index + 1}`,
      });
    }
    expect([...ids].sort()).toEqual(['test-node', 'test-node-2']);
    expect(await treeEntries()).toEqual(['test-node', 'test-node-2', 'tree.md']);
    expect(ctx.locks.isLocked('rust')).toBe(false);
  });

  it('questions under different parents (main and side) run concurrently', async () => {
    const gate = deferred();
    await setup(
      perQuestionAgent({
        gates: { main: gate.promise, side: gate.promise },
        names: { A: 'a', B: 'b', main: 'main', side: 'side' },
      }),
    );
    await askAndSettle(ctx, { parentId: '', text: 'A' });
    await askAndSettle(ctx, { parentId: 'a', text: 'B' });
    const main = await post({ parentId: 'a', text: 'main' });
    const side = await post({
      parentId: 'a/b',
      text: 'side',
      context: { kind: 'side', anchor: 'a' },
    });
    expect(ctx.locks.status('rust').shared).toBe(2);
    gate.open();
    expect(expectDone((await settle(ctx, main)).question).nodeId).toBe('a/main');
    expect(expectDone((await settle(ctx, side)).question).nodeId).toBe('a/b/side');
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('structural ops during a question → 409 with blocker details, then 200', async () => {
    const gate = deferred();
    await setup(perQuestionAgent({ gates: { slow: gate.promise }, names: { first: 'first' } }));
    await askAndSettle(ctx, { parentId: '', text: 'first' });
    const res = await post({ parentId: 'first', text: 'slow' });
    const { id } = res.json().question;

    const details = {
      questions: [
        {
          id,
          tree: 'rust',
          parentId: 'first',
          context: { kind: 'main' },
          title: 'slow',
          status: 'streaming',
        },
      ],
      preparing: 0,
    };
    const remove = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/trees/rust/nodes/delete',
        payload: { ids: ['first'] },
      });
    const busyDelete = await remove();
    expect(busyDelete.statusCode).toBe(409);
    expect(busyDelete.json()).toEqual({
      error: STREAMING_BUSY,
      code: 'tree_busy_streaming',
      details,
    });
    const busyMove = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/move',
      payload: { ids: ['first'], targetParentId: '' },
    });
    expect(busyMove.statusCode).toBe(409);
    expect(busyMove.json().details).toEqual(details);
    const busyTitle = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/trees/rust',
      payload: { title: 'Other' },
    });
    expect(busyTitle.statusCode).toBe(409);
    expect(busyTitle.json().details).toEqual(details);

    gate.open();
    expect(expectDone((await settle(ctx, res)).question).nodeId).toBe('first/test-node');
    expect((await remove()).statusCode).toBe(200);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('start while a move/delete holds the tree → 409 tree_busy_structural, agent not called', async () => {
    const agent = fakeAgent();
    await setup(agent);
    const release = ctx.locks.acquireExclusive('rust');
    const res = await post({ parentId: '', text: 'Q' });
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({
      error:
        'Tree "rust" is busy: nodes are being moved, renamed or deleted. Try again in a moment.',
      code: 'tree_busy_structural',
    });
    expect(agent.calls).toEqual([]);
    expect(ctx.questions.list()).toEqual([]);
    expect(await treeEntries()).toEqual(['tree.md']);
    release();
    await askAndSettle(ctx, { parentId: '', text: 'Q' });
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('a client gone right after the 202 does not stop the answer', async () => {
    const gate = deferred();
    await setup(perQuestionAgent({ gates: { kept: gate.promise }, names: { kept: 'kept' } }));
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/trees/rust/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: '', text: 'kept' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(202);
    const { question } = (await res.json()) as { question: { id: string } };
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.open();
    expect(expectDone(await ctx.questions.settled(question.id)).nodeId).toBe('kept');
    expect(await treeEntries()).toEqual(['kept', 'tree.md']);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('404 tree_not_found for the old id after a tree rename', async () => {
    await setup(fakeAgent());
    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/trees/rust',
      payload: { title: 'Rust Basics' },
    });
    expect(renamed.json().id).toBe('rust-basics');
    const res = await post({ parentId: '', text: 'Q' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().code).toBe('tree_not_found');
    expect(await readdir(ctx.treesDir)).toEqual(['rust-basics']);
    await askAndSettle(ctx, { parentId: '', text: 'Q' }, 'rust-basics');
  });

  it('POST /messages is gone (404)', async () => {
    await setup(fakeAgent());
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/messages',
      payload: { parentId: '', text: 'Q' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('Unicode end to end: Cyrillic node ids, NFD ids normalized to NFC', async () => {
    await setup(fakeAgent({ name: 'Ёлка и ёж' }));
    const { question } = await askAndSettle(ctx, { parentId: '', text: 'Про ёлку' });
    const nodeId = expectDone(question).nodeId;
    expect(nodeId).toBe('ёлка-и-ёж');
    expect(nodeId).toBe(nodeId.normalize('NFC'));
    const nfd = nodeId.normalize('NFD');
    expect(nfd).not.toBe(nodeId);

    const chain = await ctx.app.inject({
      method: 'GET',
      url: `/api/trees/rust/chain?node=${encodeURIComponent(nfd)}`,
    });
    expect(chain.statusCode).toBe(200);
    expect(chain.json().chain[0]).toMatchObject({ id: nodeId, name: nodeId, user: 'Про ёлку' });

    const follow = await askAndSettle(ctx, {
      parentId: nfd,
      text: 'Ещё',
      context: { kind: 'side', anchor: nfd },
    });
    expect(follow.started).toMatchObject({
      parentId: nodeId,
      context: { kind: 'side', anchor: nodeId },
    });
    expect(expectDone(follow.question).nodeId).toBe(`${nodeId}/ёлка-и-ёж`);
    const tree = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust' });
    expect(tree.json().nodes).toMatchObject([
      { id: nodeId, name: nodeId, children: [{ id: `${nodeId}/ёлка-и-ёж` }] },
    ]);
  });

  describe('GET /api/questions and /api/questions/:id', () => {
    it('lists questions (all or one tree) with live state, sorted by createdAt', async () => {
      const gate = deferred();
      await setup(perQuestionAgent({ gates: { slow: gate.promise } }));
      await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Go' } });
      const done = await askAndSettle(ctx, { parentId: '', text: 'fast' }, 'go');
      const running = await post({ parentId: '', text: 'slow' });
      const { id } = running.json().question;
      await waitFor(() => ctx.events.text(id) === 'slow:1');

      const all = await ctx.app.inject({ method: 'GET', url: '/api/questions' });
      expect(all.statusCode).toBe(200);
      expect(all.json()).toEqual({
        instance: ctx.questions.instance,
        questions: [
          { ...done.question, live: null },
          {
            ...running.json().question,
            live: { attempt: 1, answer: 'slow:1', attachments: [] },
          },
        ],
      });
      const rust = await ctx.app.inject({ method: 'GET', url: '/api/questions?tree=rust' });
      expect(rust.json().questions.map((q: { id: string }) => q.id)).toEqual([id]);
      const unknown = await ctx.app.inject({ method: 'GET', url: '/api/questions?tree=nope' });
      expect(unknown.json()).toEqual({ instance: ctx.questions.instance, questions: [] });

      const detail = await getQuestion(id);
      expect(detail.json().question).toMatchObject({
        id,
        status: 'streaming',
        live: { answer: 'slow:1' },
      });
      gate.open();
      await ctx.questions.settled(id);
      expect((await getQuestion(id)).json().question).toMatchObject({
        status: 'done',
        live: null,
      });
    });

    it('400 for a non-UUID id, 404 question_not_found for an unknown one', async () => {
      await setup(fakeAgent());
      expect((await getQuestion('nope')).statusCode).toBe(400);
      const unknown = await getQuestion('00000000-0000-4000-8000-000000000000');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({
        error: 'Question not found: 00000000-0000-4000-8000-000000000000',
        code: 'question_not_found',
      });
    });
  });

  describe('DELETE /api/questions/:id', () => {
    it('cancels a running question: 204 after teardown, nothing written, the other completes', async () => {
      const gate = deferred();
      await setup(
        perQuestionAgent({
          gates: { cancelled: new Promise<void>(() => {}), kept: gate.promise },
          names: { cancelled: 'cancelled', kept: 'kept' },
        }),
      );
      const cancelled = await post({ parentId: '', text: 'cancelled' });
      const kept = await post({ parentId: '', text: 'kept' });
      const { id } = cancelled.json().question;
      expect(ctx.locks.status('rust').shared).toBe(2);

      const res = await del(id);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      // The teardown happened before the 204.
      expect(ctx.locks.status('rust').shared).toBe(1);
      expect(eventKinds(ctx.events.forQuestion(id)).at(-1)).toBe('removed:cancelled');
      expect(ctx.events.forQuestion(id).at(-1)?.data).toEqual({
        id,
        tree: 'rust',
        reason: 'cancelled',
      });
      expect(ctx.questions.get(id)).toBeUndefined();
      expect((await getQuestion(id)).statusCode).toBe(404);
      expect((await del(id)).statusCode).toBe(404);

      gate.open();
      expect(expectDone((await settle(ctx, kept)).question).nodeId).toBe('kept');
      expect(await treeEntries()).toEqual(['kept', 'tree.md']);
      expect(ctx.locks.status('rust')).toEqual(IDLE);
    });

    it('cancels while naming', async () => {
      const naming = deferred();
      const agent = fakeAgent({
        nameGate: () => {
          naming.open();
          return new Promise(() => {});
        },
      });
      await setup(agent);
      const res = await post({ parentId: '', text: 'Q' });
      const { id } = res.json().question;
      await naming.promise;
      expect(ctx.questions.get(id)?.status).toBe('naming');
      expect((await del(id)).statusCode).toBe(204);
      expect(eventKinds(ctx.events.forQuestion(id))).toEqual([
        'question:streaming',
        'chunk',
        'chunk',
        'question:naming',
        'removed:cancelled',
      ]);
      expect(agent.nameCalls[0]?.signal.aborted).toBe(true);
      expect(await treeEntries()).toEqual(['tree.md']);
      expect(ctx.locks.status('rust')).toEqual(IDLE);
    });

    it('409 question_finished when the commit already started', async () => {
      const commit = deferred();
      const reached = deferred();
      await setup(fakeAgent({ name: 'committed' }), {
        hooks: {
          beforeCommit: async () => {
            reached.open();
            await commit.promise;
          },
        },
      });
      const res = await post({ parentId: '', text: 'Q' });
      const { id } = res.json().question;
      await reached.promise;
      const pending = del(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      commit.open();
      const conflict = await pending;
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        error: `Question ${id} already produced node "committed"`,
        code: 'question_finished',
        details: { nodeId: 'committed' },
      });
      expect(await treeEntries()).toEqual(['committed', 'tree.md']);
    });

    it('409 for a done question, 204 dismissed for a failed one', async () => {
      await setup(flakyAgent(1, 'ok'));
      const failed = await askAndSettle(ctx, { parentId: '', text: 'Q' });
      expectFailed(failed.question);
      const done = await askAndSettle(ctx, { parentId: '', text: 'Q' });
      expectDone(done.question);

      const conflict = await del(done.started.id);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({
        code: 'question_finished',
        details: { nodeId: 'ok' },
      });
      expect(ctx.questions.get(done.started.id)?.status).toBe('done');

      expect((await del(failed.started.id)).statusCode).toBe(204);
      expect(ctx.events.forQuestion(failed.started.id).at(-1)?.data).toEqual({
        id: failed.started.id,
        tree: 'rust',
        reason: 'dismissed',
      });
      expect(ctx.questions.get(failed.started.id)).toBeUndefined();
    });

    it('400 for a non-UUID id, 404 for an unknown one', async () => {
      await setup(fakeAgent());
      expect((await del('nope')).statusCode).toBe(400);
      const unknown = await del('00000000-0000-4000-8000-000000000000');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().code).toBe('question_not_found');
    });

    it('ignores any body of DELETE and retry (even an empty JSON one)', async () => {
      await setup(flakyAgent(1));
      const failed = await askAndSettle(ctx, { parentId: '', text: 'Q' });
      const id = failed.started.id;
      for (const extra of [
        { headers: { 'content-type': 'application/json' } },
        { headers: { 'content-type': 'application/json' }, payload: '{"model":"x"}' },
        { headers: { 'content-type': 'text/plain' }, payload: 'x' },
      ]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/questions/00000000-0000-4000-8000-000000000000/retry',
          ...extra,
        });
        expect(res.statusCode, JSON.stringify(extra)).toBe(404);
      }
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/questions/${id}`,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /api/questions/:id/retry', () => {
    it('re-runs a failed question under the same id with attempt 2', async () => {
      const agent = flakyAgent(1, 'recovered');
      await setup(agent);
      const first = await askAndSettle(ctx, { parentId: '', text: 'Q' });
      const failed = expectFailed(first.question);
      expect(ctx.questions.detail(failed.id)?.live?.answer).toBe('try 1');

      const res = await retry(failed.id);
      expect(res.statusCode).toBe(202);
      expect(res.headers.location).toBe(`/api/questions/${failed.id}`);
      const restarted = res.json().question;
      expect(restarted).toMatchObject({ id: failed.id, attempt: 2, status: 'streaming' });
      expect(restarted).not.toHaveProperty('error');
      expect(restarted.createdAt).toBe(failed.createdAt);

      const question = expectDone(await ctx.questions.settled(failed.id));
      expect(question).toMatchObject({ id: failed.id, attempt: 2, nodeId: 'recovered' });
      const events = ctx.events.forQuestion(failed.id);
      expect(eventKinds(events)).toEqual([
        'question:streaming',
        'chunk',
        'question:failed',
        'question:streaming',
        'chunk',
        'question:naming',
        'question:done',
      ]);
      // The retry's `question` precedes its chunks, which restart at offset 0.
      expect(events[4]?.data).toMatchObject({ attempt: 2, offset: 0, text: 'try 2' });
      expect(ctx.events.text(failed.id, 2)).toBe('try 2');
      expect(agent.calls).toHaveLength(2);
      expect(agent.calls[1]).toMatchObject({ question: 'Q', model: 'answer-default' });
      expect(await treeEntries()).toEqual(['recovered', 'tree.md']);
      expect(ctx.locks.status('rust')).toEqual(IDLE);
    });

    it('409 question_not_failed for running, done and concurrent retries', async () => {
      const gate = deferred();
      let calls = 0;
      const agent: Agent = {
        async *ask(input): AsyncGenerator<AgentEvent> {
          calls++;
          if (calls === 1) throw new Error('boom');
          await gate.promise;
          yield { type: 'done', text: 'ok', model: input.model };
        },
        async name() {
          return 'ok';
        },
      };
      await setup(agent);
      const failed = await askAndSettle(ctx, { parentId: '', text: 'Q' });
      const id = failed.started.id;

      // A retry being prepared: the second one conflicts.
      const firstRetry = ctx.questions.retry(id);
      const concurrent = await retry(id);
      expect(concurrent.statusCode).toBe(409);
      expect(concurrent.json()).toMatchObject({ code: 'question_not_failed' });
      await firstRetry;

      // Running.
      const running = await retry(id);
      expect(running.statusCode).toBe(409);
      expect(running.json().code).toBe('question_not_failed');

      gate.open();
      expectDone(await ctx.questions.settled(id));
      const done = await retry(id);
      expect(done.statusCode).toBe(409);
      expect(done.json().code).toBe('question_not_failed');
      expect((await retry('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await retry('nope')).statusCode).toBe(400);
    });

    it('409 tree_busy_structural under an exclusive lock; the entry stays failed', async () => {
      await setup(flakyAgent(1));
      const failed = await askAndSettle(ctx, { parentId: '', text: 'Q' });
      const id = failed.started.id;
      const before = ctx.questions.get(id);
      const eventCount = ctx.events.all.length;
      const release = ctx.locks.acquireExclusive('rust');
      const res = await retry(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('tree_busy_structural');
      expect(ctx.questions.get(id)).toEqual(before);
      expect(ctx.events.all).toHaveLength(eventCount);
      release();
      expect((await retry(id)).statusCode).toBe(202);
      expectDone(await ctx.questions.settled(id));
    });

    it('404 parent_not_found when the parent vanished on disk; the entry stays failed', async () => {
      // `follow-up` fails; everything else is answered.
      const agent: Agent = {
        async *ask(input): AsyncGenerator<AgentEvent> {
          if (input.question === 'follow-up') throw new Error('boom');
          yield { type: 'done', text: 'A', model: input.model };
        },
        async name(input) {
          return input.question;
        },
      };
      await setup(agent);
      await askAndSettle(ctx, { parentId: '', text: 'anchor' });
      const failed = await askAndSettle(ctx, { parentId: 'anchor', text: 'follow-up' });
      const id = failed.started.id;
      expectFailed(failed.question);
      await rm(path.join(treeDir(), 'anchor'), { recursive: true });

      const res = await retry(id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Parent node not found: anchor',
        code: 'parent_not_found',
      });
      expect(ctx.questions.get(id)).toMatchObject({ status: 'failed', attempt: 1 });
      expect(ctx.locks.status('rust')).toEqual(IDLE);
      expect(await tempEntries(treeDir())).toEqual([]);
    });

    it('watchdog: an attempt over attemptTimeoutMs fails with code timeout', async () => {
      await setup(fakeAgent({ gate: () => new Promise(() => {}) }), {
        timings: { attemptTimeoutMs: 50 },
      });
      const { question } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
      const failed = expectFailed(question);
      expect(failed.error.code).toBe('timeout');
      expect(failed.error.message).toMatch(/took longer than 1 second/);
      expect(await treeEntries()).toEqual(['tree.md']);
      expect(ctx.locks.status('rust')).toEqual(IDLE);
    });
  });
});
