import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TreeLocks } from '../src/agent/index.js';
import { buildApp } from '../src/app.js';
import { createNode, type HierarchyNode } from '../src/storage/index.js';
import { fakeAgent, makeTempDir } from './helpers.js';

/** Flatten a hierarchy into sorted ids. */
function ids(nodes: HierarchyNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...ids(n.children)]).sort();
}

describe('node management API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let locks: TreeLocks;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const temp = await makeTempDir();
    cleanup = temp.cleanup;
    locks = new TreeLocks();
    app = await buildApp({ treesDir: temp.dir, agent: fakeAgent(), locks });
    await app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    const treeDir = path.join(temp.dir, 'rust');
    let minute = 0;
    const add = (parent: string, name: string) =>
      createNode(treeDir, parent, name, {
        created: new Date(Date.UTC(2026, 8, 23, 10, minute++)).toISOString(),
        model: 'm',
        user: `Q ${name}`,
        assistant: `A ${name}`,
      });
    // ownership/{borrowing/{rules}, moves}, lifetimes, traits/{borrowing}
    await add('', 'ownership');
    await add('ownership', 'borrowing');
    await add('ownership/borrowing', 'rules');
    await add('ownership', 'moves');
    await add('', 'lifetimes');
    await add('', 'traits');
    await add('traits', 'borrowing');
  });
  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  const del = (body: object) =>
    app.inject({ method: 'POST', url: '/api/trees/rust/nodes/delete', payload: body });
  const move = (body: object) =>
    app.inject({ method: 'POST', url: '/api/trees/rust/nodes/move', payload: body });

  it('deletes a single node with its subtree', async () => {
    const res = await del({ ids: ['ownership/borrowing'] });
    expect(res.statusCode).toBe(200);
    expect(ids(res.json().nodes)).toEqual([
      'lifetimes',
      'ownership',
      'ownership/moves',
      'traits',
      'traits/borrowing',
    ]);
  });

  it('deletes many nodes, skipping those whose ancestor is selected', async () => {
    const res = await del({
      ids: ['ownership/borrowing/rules', 'ownership', 'traits/borrowing', 'ownership/moves'],
    });
    expect(res.statusCode).toBe(200);
    expect(ids(res.json().nodes)).toEqual(['lifetimes', 'traits']);
  });

  it('moves a single node with its subtree', async () => {
    const res = await move({ ids: ['ownership/borrowing'], targetParentId: 'lifetimes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toEqual({ 'ownership/borrowing': 'lifetimes/borrowing' });
    expect(ids(res.json().nodes)).toEqual([
      'lifetimes',
      'lifetimes/borrowing',
      'lifetimes/borrowing/rules',
      'ownership',
      'ownership/moves',
      'traits',
      'traits/borrowing',
    ]);
    const chain = await app.inject({
      method: 'GET',
      url: '/api/trees/rust/chain?node=lifetimes/borrowing/rules',
    });
    expect(chain.json().chain.map((n: { user: string }) => n.user)).toEqual([
      'Q lifetimes',
      'Q borrowing',
      'Q rules',
    ]);
  });

  it('moves many nodes to root, skipping nested selection', async () => {
    const res = await move({
      ids: ['ownership/moves', 'ownership/borrowing', 'ownership/borrowing/rules'],
      targetParentId: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toEqual({
      'ownership/moves': 'moves',
      'ownership/borrowing': 'borrowing',
    });
    expect(ids(res.json().nodes)).toEqual([
      'borrowing',
      'borrowing/rules',
      'lifetimes',
      'moves',
      'ownership',
      'traits',
      'traits/borrowing',
    ]);
  });

  it('adds a -2 suffix on name collision at the target', async () => {
    const res = await move({ ids: ['traits/borrowing'], targetParentId: 'ownership' });
    expect(res.json().moved).toEqual({ 'traits/borrowing': 'ownership/borrowing-2' });
    const both = await move({
      ids: ['ownership/borrowing', 'ownership/borrowing-2'],
      targetParentId: 'lifetimes',
    });
    expect(both.json().moved).toEqual({
      'ownership/borrowing': 'lifetimes/borrowing',
      'ownership/borrowing-2': 'lifetimes/borrowing-2',
    });
  });

  it('leaves a node in place when it already sits under the target', async () => {
    const res = await move({ ids: ['ownership/moves'], targetParentId: 'ownership' });
    expect(res.json().moved).toEqual({ 'ownership/moves': 'ownership/moves' });
  });

  it('rejects moving into itself or a descendant (400), changing nothing', async () => {
    const before = ids((await app.inject({ method: 'GET', url: '/api/trees/rust' })).json().nodes);
    for (const body of [
      { ids: ['ownership'], targetParentId: 'ownership' },
      { ids: ['ownership'], targetParentId: 'ownership/borrowing/rules' },
      { ids: ['lifetimes', 'ownership'], targetParentId: 'ownership/moves' },
    ]) {
      expect((await move(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    const after = ids((await app.inject({ method: 'GET', url: '/api/trees/rust' })).json().nodes);
    expect(after).toEqual(before);
  });

  it('rejects invalid input', async () => {
    expect((await del({ ids: [] })).statusCode).toBe(400);
    expect((await del({ ids: [''] })).statusCode).toBe(400);
    expect((await del({ ids: ['../x'] })).statusCode).toBe(400);
    expect((await del({ ids: ['missing'] })).statusCode).toBe(404);
    expect((await move({ ids: ['lifetimes'] })).statusCode).toBe(400);
    expect((await move({ ids: ['lifetimes'], targetParentId: 'missing' })).statusCode).toBe(404);
    const unknownTree = await app.inject({
      method: 'POST',
      url: '/api/trees/nope/nodes/delete',
      payload: { ids: ['a'] },
    });
    expect(unknownTree.statusCode).toBe(404);
  });

  it('409 while the tree lock is held', async () => {
    const release = locks.acquire('rust');
    expect((await del({ ids: ['lifetimes'] })).statusCode).toBe(409);
    expect((await move({ ids: ['lifetimes'], targetParentId: 'ownership' })).statusCode).toBe(409);
    release();
    expect((await del({ ids: ['lifetimes'] })).statusCode).toBe(200);
  });
});
