import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SuggestInput } from '../src/agent/index.js';
import { parseNodeFile } from '../src/storage/index.js';
import {
  askAndSettle,
  deferred,
  eventKinds,
  expectDone,
  type FakeAgentOptions,
  fakeAgent,
  makeApp,
  multipartMessage,
  postQuestion,
  TEST_MODELS,
  type TestContext,
  tick,
  waitFor,
} from './helpers.js';

describe('suggestions generated at save', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  const treeDir = () => path.join(ctx.treesDir, 'rust');
  const readNode = async (id: string) =>
    parseNodeFile(await readFile(path.join(treeDir(), ...id.split('/'), 'node.md'), 'utf8'));
  const getSuggestions = (node: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/trees/rust/suggestions?node=${encodeURIComponent(node)}`,
    });

  async function setup(options: FakeAgentOptions = {}) {
    const agent = fakeAgent(options);
    ctx = await makeApp(agent, TEST_MODELS);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    return agent;
  }

  /** POST and wait for the question only (not for suggestion generations). */
  async function askOnly(body: object) {
    const res = await postQuestion(ctx, body);
    expect(res.statusCode).toBe(202);
    const id = res.json().question.id as string;
    return { id, question: expectDone(await ctx.questions.settled(id)) };
  }

  it('stores the list with the node when it is ready before naming (single write)', async () => {
    const returned = deferred();
    const agent = await setup({
      suggest: () => {
        returned.open();
        return [{ text: 'What next?' }];
      },
      nameGate: async () => {
        await returned.promise;
        await tick(20);
      },
    });
    const { question } = await askOnly({ parentId: '', text: 'Q' });
    // Read before any background write could happen.
    expect((await readNode(question.nodeId)).suggestions).toEqual([{ text: 'What next?', up: 0 }]);
    expect(agent.suggestCalls).toHaveLength(1);
    expect(agent.suggestCalls[0]).toMatchObject({
      ancestors: [],
      current: { user: 'Q', assistant: 'Hello, world' },
      candidates: [],
      model: TEST_MODELS.suggest,
    });
    expect(agent.suggestCalls[0]?.current.id).toBeUndefined();
  });

  it('commits without waiting; a slower generation is written later and joined by POST', async () => {
    const gate = deferred();
    const agent = await setup({ suggest: [{ text: 'Later' }], suggestGate: () => gate.promise });
    const { question } = await askOnly({ parentId: '', text: 'Q' });
    expect(agent.suggestCalls).toHaveLength(1);
    expect((await readNode(question.nodeId)).suggestions).toBeUndefined();
    expect((await getSuggestions(question.nodeId)).json().state).toBe('missing');

    const joined = ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/suggestions',
      payload: { node: question.nodeId },
    });
    await tick(20);
    gate.open();
    const res = await joined;
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestions).toEqual([{ text: 'Later', target: question.nodeId, up: 0 }]);
    expect(agent.suggestCalls).toHaveLength(1);
    expect((await readNode(question.nodeId)).suggestions).toEqual([{ text: 'Later', up: 0 }]);
  });

  it('an adopted generation writes even when nobody asks for it', async () => {
    const gate = deferred();
    await setup({ suggest: [{ text: 'Later' }], suggestGate: () => gate.promise });
    const { question } = await askOnly({ parentId: '', text: 'Q' });
    gate.open();
    await waitFor(async () => (await readNode(question.nodeId)).suggestions !== undefined);
    expect((await readNode(question.nodeId)).suggestions).toEqual([{ text: 'Later', up: 0 }]);
  });

  it('a failed generation never fails the question; the node stays missing', async () => {
    const agent = await setup({ suggestError: 'model down' });
    const { question, events } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    const done = expectDone(question);
    expect(eventKinds(events)).toEqual([
      'question:streaming',
      'chunk',
      'chunk',
      'question:naming',
      'question:done',
    ]);
    expect(agent.suggestCalls).toHaveLength(1);
    expect((await readNode(done.nodeId)).suggestions).toBeUndefined();
  });

  it('cancel during naming aborts the generation; nothing is written', async () => {
    let suggestSignal: AbortSignal | undefined;
    const agent = await setup({
      nameGate: () => new Promise(() => undefined),
      suggestGate: (input: SuggestInput) => {
        suggestSignal = input.signal;
        return new Promise(() => undefined);
      },
    });
    const res = await postQuestion(ctx, { parentId: '', text: 'Q' });
    const id = res.json().question.id as string;
    await waitFor(() => agent.suggestCalls.length === 1 && agent.nameCalls.length === 1);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/questions/${id}` });
    expect(del.statusCode).toBe(204);
    expect(suggestSignal?.aborted).toBe(true);
    await ctx.suggestions.idle();
    expect((await readdir(treeDir())).sort()).toEqual(['tree.md']);
  });

  it('inherits from the parent end to end and hides used suggestions', async () => {
    const agent = await setup({
      suggest: (input) => {
        if (input.current.user === 'plan') {
          return [{ text: 'Глава 1' }, { text: 'Глава 2' }, { text: 'Глава 3' }];
        }
        if (input.current.user === 'Глава 1') return [{ keep: 0 }, { keep: 1 }];
        return [];
      },
    });
    const plan = expectDone((await askAndSettle(ctx, { parentId: '', text: 'plan' })).question);
    expect((await readNode(plan.nodeId)).suggestions).toEqual([
      { text: 'Глава 1', up: 0 },
      { text: 'Глава 2', up: 0 },
      { text: 'Глава 3', up: 0 },
    ]);

    const first = expectDone(
      (await askAndSettle(ctx, { parentId: plan.nodeId, text: 'Глава 1' })).question,
    );
    expect(agent.suggestCalls[1]?.candidates).toEqual([
      { text: 'Глава 2', source: plan.nodeId, origin: 0 },
      { text: 'Глава 3', source: plan.nodeId, origin: 0 },
    ]);
    expect(agent.suggestCalls[1]?.ancestors).toEqual([
      { id: plan.nodeId, user: 'plan', assistant: 'Hello, world' },
    ]);
    expect((await readNode(first.nodeId)).suggestions).toEqual([
      { text: 'Глава 2', up: 1 },
      { text: 'Глава 3', up: 1 },
    ]);
    expect((await getSuggestions(first.nodeId)).json().suggestions).toEqual([
      { text: 'Глава 2', target: plan.nodeId, up: 1 },
      { text: 'Глава 3', target: plan.nodeId, up: 1 },
    ]);
    // Under the plan, `Глава 1` is used now.
    expect((await getSuggestions(plan.nodeId)).json().suggestions).toEqual([
      { text: 'Глава 2', target: plan.nodeId, up: 0 },
      { text: 'Глава 3', target: plan.nodeId, up: 0 },
    ]);

    // Clicking the inherited `Глава 2` asks it from the plan: a sibling of `Глава 1`.
    await askAndSettle(ctx, { parentId: plan.nodeId, text: 'Глава 2' });
    expect((await getSuggestions(first.nodeId)).json().suggestions).toEqual([
      { text: 'Глава 3', target: plan.nodeId, up: 1 },
    ]);
    // The sibling is offered what is left of the plan's list (asked and used items removed).
    expect(agent.suggestCalls[2]?.candidates).toEqual([
      { text: 'Глава 3', source: plan.nodeId, origin: 0 },
    ]);
  });

  it('a files-only message is the naming question for suggestions', async () => {
    const agent = await setup();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/questions',
      ...multipartMessage({ parentId: '' }, [{ name: 'notes.md', content: '# Notes' }]),
    });
    expect(res.statusCode).toBe(202);
    expectDone(await ctx.questions.settled(res.json().question.id));
    await ctx.suggestions.idle();
    expect(agent.suggestCalls[0]?.current.user).toBe('Attached files: notes.md');
    expect(agent.suggestCalls[0]?.model).toBe(TEST_MODELS.suggest);
  });

  it('new nodes get a stored empty list from the default fake', async () => {
    await setup();
    const { question } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    expect((await readNode(expectDone(question).nodeId)).suggestions).toEqual([]);
    expect((await getSuggestions(expectDone(question).nodeId)).json()).toMatchObject({
      state: 'ready',
      suggestions: [],
    });
  });
});
