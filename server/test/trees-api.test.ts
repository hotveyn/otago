import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNode } from '../src/storage/index.js';
import { makeApp } from './helpers.js';

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
      id: 'rust',
      title: 'Rust 2',
      instructions: 'new instructions',
    });

    const bad = await ctx.app.inject({ method: 'PATCH', url: '/api/trees/rust', payload: {} });
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
