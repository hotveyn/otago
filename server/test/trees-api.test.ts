import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, AgentEvent } from '../src/agent/index.js';
import { createNode } from '../src/storage/index.js';
import {
  askAndSettle,
  eventKinds,
  expectDone,
  expectFailed,
  makeApp,
  TEST_MODELS,
  type TestContext,
} from './helpers.js';

describe('trees API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(() => ctx.close());

  const create = (body: object) =>
    ctx.app.inject({ method: 'POST', url: '/api/trees', payload: body });

  it('GET /api/health', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('creates and lists trees', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/trees' })).json()).toEqual({
      trees: [],
    });

    const res = await create({ title: 'Rust basics', instructions: 'Answer in Russian.' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'rust-basics',
      title: 'Rust basics',
      instructions: 'Answer in Russian.',
    });
    const file = await readFile(path.join(ctx.treesDir, 'rust-basics', 'tree.md'), 'utf8');
    expect(file).toContain('title: Rust basics');
    expect(file).toContain('Answer in Russian.');

    await create({ title: 'Rust basics' });
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/trees' })).json();
    expect(list.trees.map((t: { id: string }) => t.id)).toEqual(['rust-basics', 'rust-basics-2']);
  });

  it('rejects invalid tree input', async () => {
    expect((await create({})).statusCode).toBe(400);
    expect((await create({ title: '   ' })).statusCode).toBe(400);
    expect((await create({ title: 1 })).statusCode).toBe(400);
  });

  it('returns tree meta with hierarchy', async () => {
    await create({ title: 'Rust' });
    const treeDir = path.join(ctx.treesDir, 'rust');
    const n = { created: '2026-09-23T10:00:00Z', model: 'm', user: 'Q', assistant: 'A' };
    await createNode(treeDir, '', 'ownership', n);
    await createNode(treeDir, 'ownership', 'borrowing', n);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'rust',
      title: 'Rust',
      nodes: [
        {
          id: 'ownership',
          name: 'ownership',
          children: [{ id: 'ownership/borrowing', name: 'borrowing', children: [] }],
        },
      ],
    });
    expect(JSON.stringify(res.json())).not.toContain('"user"');
  });

  it('404 for an unknown tree', async () => {
    for (const url of [
      '/api/trees/nope',
      '/api/trees/..',
      '/api/trees/nope/chain',
      '/api/trees/nope/sources',
    ]) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/trees/nope',
      payload: { title: 'x' },
    });
    expect(patch.statusCode).toBe(404);
  });

  it('updates title and instructions', async () => {
    await create({ title: 'Rust', instructions: 'old' });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/trees/rust',
      payload: { instructions: 'new instructions' },
    });
    expect(res.json()).toMatchObject({
      id: 'rust',
      title: 'Rust',
      instructions: 'new instructions',
    });
    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/trees/rust',
      payload: { title: 'Rust 2' },
    });
    expect(renamed.json()).toMatchObject({
      id: 'rust-2',
      title: 'Rust 2',
      instructions: 'new instructions',
      previous: { id: 'rust', title: 'Rust' },
    });

    const bad = await ctx.app.inject({ method: 'PATCH', url: '/api/trees/rust-2', payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it('returns the chain of a node', async () => {
    await create({ title: 'Rust' });
    const treeDir = path.join(ctx.treesDir, 'rust');
    await createNode(treeDir, '', 'a', {
      created: '2026-09-23T10:00:00Z',
      model: 'm',
      user: 'Q1',
      assistant: 'A1',
    });
    await createNode(treeDir, 'a', 'b', {
      created: '2026-09-23T11:00:00Z',
      model: 'm',
      user: 'Q2',
      assistant: 'A2',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/chain?node=a/b' });
    expect(res.statusCode).toBe(200);
    expect(res.json().chain).toMatchObject([
      { id: 'a', user: 'Q1', assistant: 'A1' },
      { id: 'a/b', user: 'Q2', assistant: 'A2' },
    ]);

    const root = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/chain' });
    expect(root.json()).toEqual({ chain: [] });

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/rust/chain?node=a/zzz',
    });
    expect(missing.statusCode).toBe(404);
    const traversal = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/rust/chain?node=../x',
    });
    expect(traversal.statusCode).toBe(400);
  });
});

describe('tree rename (PATCH title)', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    const n = { created: '2026-09-23T10:00:00Z', model: 'm', user: 'Q', assistant: 'A' };
    await createNode(path.join(ctx.treesDir, 'rust'), '', 'ownership', n);
  });
  afterEach(() => ctx.close());

  const patch = (tree: string, payload: object) =>
    ctx.app.inject({ method: 'PATCH', url: `/api/trees/${tree}`, payload });
  const get = (tree: string) => ctx.app.inject({ method: 'GET', url: `/api/trees/${tree}` });
  const listIds = async () =>
    (await ctx.app.inject({ method: 'GET', url: '/api/trees' }))
      .json()
      .trees.map((t: { id: string }) => t.id);

  it('renames the folder; the old id stops working', async () => {
    const before = (await get('rust')).json().nodes;
    const res = await patch('rust', { title: 'Rust Basics' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'rust-basics',
      title: 'Rust Basics',
      previous: { id: 'rust', title: 'Rust' },
    });
    const old = await get('rust');
    expect(old.statusCode).toBe(404);
    expect(old.json().code).toBe('tree_not_found');
    const renamed = await get('rust-basics');
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().nodes).toEqual(before);
    expect(await listIds()).toEqual(['rust-basics']);
    expect(ctx.locks.isLocked('rust')).toBe(false);
    expect(ctx.locks.isLocked('rust-basics')).toBe(false);
  });

  it('instructions-only patch keeps the id', async () => {
    const res = await patch('rust', { instructions: 'x' });
    expect(res.json()).toMatchObject({ id: 'rust', previous: { id: 'rust', title: 'Rust' } });
  });

  it('same slug keeps the id and updates the title', async () => {
    const res = await patch('rust', { title: 'RUST' });
    expect(res.json()).toMatchObject({ id: 'rust', title: 'RUST', previous: { id: 'rust' } });
    expect((await get('rust')).json().title).toBe('RUST');
  });

  it('collision with another tree gets -2', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Go' } });
    const res = await patch('rust', { title: 'Go' });
    expect(res.json().id).toBe('go-2');
    expect((await listIds()).sort()).toEqual(['go', 'go-2']);
  });

  it('title change while a stream holds the tree → 409; instructions still allowed', async () => {
    const release = ctx.locks.acquireShared('rust');
    const res = await patch('rust', { title: 'Other' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Tree "rust" is busy: an answer is still streaming. Try again when it finishes.',
      code: 'tree_busy_streaming',
      details: { questions: [], preparing: 1 },
    });
    expect((await patch('rust', { instructions: 'ok' })).statusCode).toBe(200);
    release();
    expect(ctx.locks.isLocked('rust')).toBe(false);
  });

  it('409 tree_busy_structural while another structural op runs', async () => {
    const release = ctx.locks.acquireExclusive('rust');
    const res = await patch('rust', { title: 'Other' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error:
        'Tree "rust" is busy: nodes are being moved, renamed or deleted. Try again in a moment.',
      code: 'tree_busy_structural',
    });
    release();
  });

  it('a lock held on the new id → 409, nothing renamed, locks released', async () => {
    const release = ctx.locks.acquireShared('other');
    const res = await patch('rust', { title: 'Other' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('tree_busy_streaming');
    expect((await get('rust')).json().title).toBe('Rust');
    expect(await listIds()).toEqual(['rust']);
    expect(ctx.locks.isLocked('rust')).toBe(false);
    release();
    expect(ctx.locks.isLocked('other')).toBe(false);
  });

  it('undo round-trip restores the original id', async () => {
    const { id, previous } = (await patch('rust', { title: 'Rust Basics' })).json();
    const back = await patch(id, { title: previous.title });
    expect(back.json()).toMatchObject({
      id: 'rust',
      title: 'Rust',
      previous: { id: 'rust-basics', title: 'Rust Basics' },
    });
    expect(await listIds()).toEqual(['rust']);
  });
});

describe('tree rename and retained questions', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  it('rewrites `tree` on retained questions; a tree-less retry runs in the renamed tree', async () => {
    let failNext = true;
    const agent: Agent = {
      async *ask(input): AsyncGenerator<AgentEvent> {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        yield { type: 'done', text: 'A', model: input.model };
      },
      async name() {
        return 'answer';
      },
    };
    ctx = await makeApp(agent, TEST_MODELS);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Go' } });
    const failed = expectFailed((await askAndSettle(ctx, { parentId: '', text: 'Q' })).question);
    const other = expectDone((await askAndSettle(ctx, { parentId: '', text: 'Q' }, 'go')).question);
    const before = ctx.events.all.length;

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/trees/rust',
      payload: { title: 'Rust Basics' },
    });
    expect(renamed.json().id).toBe('rust-basics');
    expect(ctx.questions.get(failed.id)).toMatchObject({ tree: 'rust-basics', status: 'failed' });
    expect(ctx.questions.get(other.id)).toEqual(other);
    expect(eventKinds(ctx.events.all.slice(before))).toEqual(['question:failed']);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/questions?tree=rust-basics' });
    expect(list.json().questions.map((q: { id: string }) => q.id)).toEqual([failed.id]);

    const retried = await ctx.app.inject({
      method: 'POST',
      url: `/api/questions/${failed.id}/retry`,
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().question).toMatchObject({ tree: 'rust-basics', attempt: 2 });
    const done = expectDone(await ctx.questions.settled(failed.id));
    expect(done.nodeId).toBe('answer');
    const node = await readFile(
      path.join(ctx.treesDir, 'rust-basics', 'answer', 'node.md'),
      'utf8',
    );
    expect(node).toContain('Q');
  });
});
