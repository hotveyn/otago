import { readdir, readFile } from 'node:fs/promises';
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

  it('409 tree_busy_streaming while a stream (shared) holds the tree', async () => {
    const release = locks.acquireShared('rust');
    const deleted = await del({ ids: ['lifetimes'] });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual({
      error: 'Tree "rust" is busy: an answer is still streaming. Try again when it finishes.',
      code: 'tree_busy_streaming',
    });
    const moved = await move({ ids: ['lifetimes'], targetParentId: 'ownership' });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().code).toBe('tree_busy_streaming');
    release();
    expect((await del({ ids: ['lifetimes'] })).statusCode).toBe(200);
    expect(locks.isLocked('rust')).toBe(false);
  });

  it('409 tree_busy_structural while a move/delete (exclusive) holds the tree', async () => {
    const release = locks.acquireExclusive('rust');
    const deleted = await del({ ids: ['lifetimes'] });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().code).toBe('tree_busy_structural');
    const moved = await move({ ids: ['lifetimes'], targetParentId: 'ownership' });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().code).toBe('tree_busy_structural');
    release();
    expect((await move({ ids: ['lifetimes'], targetParentId: 'ownership' })).statusCode).toBe(200);
    expect(locks.isLocked('rust')).toBe(false);
  });

  it('error bodies without a code omit the field', async () => {
    const res = await del({ ids: [''] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).not.toHaveProperty('code');
  });

  it('404 codes: node_not_found, parent_not_found, tree_not_found', async () => {
    expect((await del({ ids: ['missing'] })).json().code).toBe('node_not_found');
    const toMissing = await move({ ids: ['lifetimes'], targetParentId: 'missing' });
    expect(toMissing.statusCode).toBe(404);
    expect(toMissing.json().code).toBe('parent_not_found');
    const unknownTree = await app.inject({
      method: 'POST',
      url: '/api/trees/nope/nodes/restore',
      payload: { trashIds: ['a.deleted-1759000000000'] },
    });
    expect(unknownTree.statusCode).toBe(404);
    expect(unknownTree.json().code).toBe('tree_not_found');
  });
});

describe('soft delete, restore and move names', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let locks: TreeLocks;
  let treeDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const temp = await makeTempDir();
    cleanup = temp.cleanup;
    locks = new TreeLocks();
    app = await buildApp({ treesDir: temp.dir, agent: fakeAgent(), locks });
    await app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    treeDir = path.join(temp.dir, 'rust');
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

  const post = (op: string, body: object) =>
    app.inject({ method: 'POST', url: `/api/trees/rust/nodes/${op}`, payload: body });
  const hierarchy = async () =>
    (await app.inject({ method: 'GET', url: '/api/trees/rust' })).json().nodes as HierarchyNode[];
  const TRASH = /^[a-z0-9-]+\.deleted-\d{13,}$/;

  it('soft-deletes: returns trash ids, keeps the subtree on disk, hides it', async () => {
    const res = await post('delete', { ids: ['ownership/borrowing/rules', 'ownership/borrowing'] });
    expect(res.statusCode).toBe(200);
    const { deleted } = res.json() as { deleted: Record<string, string> };
    expect(Object.keys(deleted)).toEqual(['ownership/borrowing']);
    const trashId = deleted['ownership/borrowing'] ?? '';
    expect(trashId.startsWith('ownership/')).toBe(true);
    expect(trashId.slice('ownership/'.length)).toMatch(TRASH);
    expect(await readdir(path.join(treeDir, 'ownership'))).toContain(
      trashId.slice('ownership/'.length),
    );
    const rules = await readFile(path.join(treeDir, trashId, 'rules', 'node.md'), 'utf8');
    expect(rules).toContain('Q rules');
    expect(ids(res.json().nodes)).toEqual([
      'lifetimes',
      'ownership',
      'ownership/moves',
      'traits',
      'traits/borrowing',
    ]);
  });

  it('restores a deleted node to the same hierarchy (round trip)', async () => {
    const before = await hierarchy();
    const { deleted } = (await post('delete', { ids: ['ownership/borrowing'] })).json();
    const res = await post('restore', { trashIds: [deleted['ownership/borrowing']] });
    expect(res.statusCode).toBe(200);
    expect(res.json().restored).toEqual({
      [deleted['ownership/borrowing']]: 'ownership/borrowing',
    });
    expect(res.json().nodes).toEqual(before);
    const rules = await readFile(
      path.join(treeDir, 'ownership', 'borrowing', 'rules', 'node.md'),
      'utf8',
    );
    expect(rules).toContain('A rules');
  });

  it('restores under a -2 name when a sibling took the original', async () => {
    const { deleted } = (await post('delete', { ids: ['ownership/borrowing'] })).json();
    await post('move', { ids: ['traits/borrowing'], targetParentId: 'ownership' });
    const res = await post('restore', { trashIds: [deleted['ownership/borrowing']] });
    expect(res.json().restored).toEqual({
      [deleted['ownership/borrowing']]: 'ownership/borrowing-2',
    });
    expect(ids(res.json().nodes)).toContain('ownership/borrowing-2/rules');
  });

  it('404 parent_not_found when the parent is gone; nothing renamed', async () => {
    const first = (await post('delete', { ids: ['ownership/borrowing'] })).json().deleted;
    const second = (await post('delete', { ids: ['lifetimes'] })).json().deleted;
    await post('delete', { ids: ['ownership'] });
    const res = await post('restore', {
      trashIds: [second.lifetimes, first['ownership/borrowing']],
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('parent_not_found');
    expect(ids(await hierarchy())).toEqual(['traits', 'traits/borrowing']);
  });

  it('404 trash_not_found for unknown / already restored ids; batch is all-or-nothing', async () => {
    const { deleted } = (await post('delete', { ids: ['lifetimes', 'traits'] })).json();
    const unknown = await post('restore', {
      trashIds: [deleted.lifetimes, 'nope.deleted-1759000000000'],
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('trash_not_found');
    expect(ids(await hierarchy())).not.toContain('lifetimes');
    expect((await post('restore', { trashIds: [deleted.lifetimes] })).statusCode).toBe(200);
    const again = await post('restore', { trashIds: [deleted.lifetimes, deleted.traits] });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('trash_not_found');
    expect(ids(await hierarchy())).not.toContain('traits');
  });

  it('de-duplicates trash ids', async () => {
    const { deleted } = (await post('delete', { ids: ['lifetimes'] })).json();
    const res = await post('restore', { trashIds: [deleted.lifetimes, deleted.lifetimes] });
    expect(res.statusCode).toBe(200);
    expect(res.json().restored).toEqual({ [deleted.lifetimes]: 'lifetimes' });
  });

  it('400 for malformed and nested trash ids', async () => {
    for (const trashId of [
      'lifetimes',
      '../x.deleted-1759000000000',
      '/abs.deleted-1759000000000',
      'a\\b.deleted-1759000000000',
      'sources/x.deleted-1759000000000',
      'x.deleted-12',
      'x.deleted-1759000000000/y.deleted-1759000000000',
    ]) {
      const res = await post('restore', { trashIds: [trashId] });
      expect(res.statusCode, trashId).toBe(400);
    }
    expect((await post('restore', { trashIds: [] })).statusCode).toBe(400);
  });

  it('LIFO: delete child, delete parent, restore parent, then restore child', async () => {
    const before = await hierarchy();
    const child = (await post('delete', { ids: ['ownership/borrowing'] })).json().deleted;
    const parent = (await post('delete', { ids: ['ownership'] })).json().deleted;
    const restoredParent = await post('restore', { trashIds: [parent.ownership] });
    expect(restoredParent.json().restored).toEqual({ [parent.ownership]: 'ownership' });
    const res = await post('restore', { trashIds: [child['ownership/borrowing']] });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toEqual(before);
  });

  it('move names: move back after a -2 forward move restores the original name', async () => {
    const forward = (
      await post('move', { ids: ['traits/borrowing'], targetParentId: 'ownership' })
    ).json().moved;
    expect(forward).toEqual({ 'traits/borrowing': 'ownership/borrowing-2' });
    const back = await post('move', {
      ids: ['ownership/borrowing-2'],
      targetParentId: 'traits',
      names: { 'ownership/borrowing-2': 'borrowing' },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().moved).toEqual({ 'ownership/borrowing-2': 'traits/borrowing' });
  });

  it('move names: taken name gets -2; same-parent nodes ignore names', async () => {
    const res = await post('move', {
      ids: ['lifetimes'],
      targetParentId: 'ownership',
      names: { lifetimes: 'moves' },
    });
    expect(res.json().moved).toEqual({ lifetimes: 'ownership/moves-2' });
    const same = await post('move', {
      ids: ['ownership/moves'],
      targetParentId: 'ownership',
      names: { 'ownership/moves': 'other' },
    });
    expect(same.json().moved).toEqual({ 'ownership/moves': 'ownership/moves' });
  });

  it('move names: 400 for invalid slug, reserved name or key not in ids', async () => {
    const before = ids(await hierarchy());
    for (const body of [
      { ids: ['lifetimes'], targetParentId: 'ownership', names: { lifetimes: 'Bad Name' } },
      { ids: ['lifetimes'], targetParentId: 'ownership', names: { lifetimes: 'a.deleted-1' } },
      { ids: ['lifetimes'], targetParentId: 'ownership', names: { lifetimes: 'files' } },
      { ids: ['ownership/moves'], targetParentId: '', names: { 'ownership/moves': 'sources' } },
      { ids: ['lifetimes'], targetParentId: 'ownership', names: { traits: 'x' } },
    ]) {
      expect((await post('move', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(ids(await hierarchy())).toEqual(before);
  });

  it('restore takes the exclusive lock (409 streaming / structural)', async () => {
    const { deleted } = (await post('delete', { ids: ['lifetimes'] })).json();
    const shared = locks.acquireShared('rust');
    const streaming = await post('restore', { trashIds: [deleted.lifetimes] });
    expect(streaming.statusCode).toBe(409);
    expect(streaming.json().code).toBe('tree_busy_streaming');
    shared();
    const exclusive = locks.acquireExclusive('rust');
    const structural = await post('restore', { trashIds: [deleted.lifetimes] });
    expect(structural.statusCode).toBe(409);
    expect(structural.json().code).toBe('tree_busy_structural');
    exclusive();
    expect((await post('restore', { trashIds: [deleted.lifetimes] })).statusCode).toBe(200);
    expect(locks.isLocked('rust')).toBe(false);
  });

  it('a node created after delete reuses the plain name', async () => {
    await post('delete', { ids: ['lifetimes'] });
    const id = await createNode(treeDir, '', 'lifetimes', {
      created: new Date().toISOString(),
      model: 'm',
      user: 'Q',
      assistant: 'A',
    });
    expect(id).toBe('lifetimes');
  });
});

describe('node rename API', () => {
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
    // ownership/{borrowing/{rules}, moves}, lifetimes
    await add('', 'ownership');
    await add('ownership', 'borrowing');
    await add('ownership/borrowing', 'rules');
    await add('ownership', 'moves');
    await add('', 'lifetimes');
  });
  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  const rename = (body: object, tree = 'rust') =>
    app.inject({ method: 'POST', url: `/api/trees/${tree}/nodes/rename`, payload: body });
  const hierarchy = async () =>
    (await app.inject({ method: 'GET', url: '/api/trees/rust' })).json().nodes as HierarchyNode[];
  const chain = (node: string) =>
    app.inject({ method: 'GET', url: `/api/trees/rust/chain?node=${encodeURIComponent(node)}` });

  it('renames a node with its subtree', async () => {
    const res = await rename({ id: 'ownership/borrowing', name: 'Borrowing Rules' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['id', 'name', 'renamed', 'nodes']);
    expect(body.id).toBe('ownership/borrowing-rules');
    expect(body.name).toBe('borrowing-rules');
    expect(body.renamed).toEqual({
      'ownership/borrowing': 'ownership/borrowing-rules',
      'ownership/borrowing/rules': 'ownership/borrowing-rules/rules',
    });
    expect(Object.keys(body.renamed)[0]).toBe('ownership/borrowing');
    expect(ids(body.nodes)).toEqual([
      'lifetimes',
      'ownership',
      'ownership/borrowing-rules',
      'ownership/borrowing-rules/rules',
      'ownership/moves',
    ]);
    expect((await chain('ownership/borrowing-rules/rules')).statusCode).toBe(200);
    const old = await chain('ownership/borrowing');
    expect(old.statusCode).toBe(404);
  });

  it('returns the actual name on collision', async () => {
    const res = await rename({ id: 'ownership/moves', name: 'Borrowing' });
    expect(res.json()).toMatchObject({ id: 'ownership/borrowing-2', name: 'borrowing-2' });
  });

  it('same slug is an identity no-op', async () => {
    const res = await rename({ id: 'ownership/borrowing', name: 'Borrowing' });
    expect(res.json()).toMatchObject({
      id: 'ownership/borrowing',
      renamed: {
        'ownership/borrowing': 'ownership/borrowing',
        'ownership/borrowing/rules': 'ownership/borrowing/rules',
      },
    });
  });

  it('schema errors → 400 Invalid input', async () => {
    for (const body of [
      { id: 'lifetimes', name: '   ' },
      { id: 'lifetimes', name: 'x'.repeat(201) },
      { name: 'x' },
      { id: 'lifetimes' },
    ]) {
      const res = await rename(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe('Invalid input');
    }
  });

  it('root, malformed, unknown node, unknown tree', async () => {
    const root = await rename({ id: '', name: 'x' });
    expect(root.statusCode).toBe(400);
    expect(root.json().error).toBe('The tree root cannot be renamed');
    expect((await rename({ id: '../x', name: 'x' })).statusCode).toBe(400);
    const missing = await rename({ id: 'missing', name: 'x' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('node_not_found');
    const tree = await rename({ id: 'lifetimes', name: 'x' }, 'nope');
    expect(tree.statusCode).toBe(404);
    expect(tree.json().code).toBe('tree_not_found');
  });

  it('409 while a stream or a structural op holds the tree', async () => {
    const shared = locks.acquireShared('rust');
    const streaming = await rename({ id: 'lifetimes', name: 'x' });
    expect(streaming.statusCode).toBe(409);
    expect(streaming.json()).toEqual({
      error: 'Tree "rust" is busy: an answer is still streaming. Try again when it finishes.',
      code: 'tree_busy_streaming',
    });
    shared();
    const exclusive = locks.acquireExclusive('rust');
    const structural = await rename({ id: 'lifetimes', name: 'x' });
    expect(structural.statusCode).toBe(409);
    expect(structural.json()).toEqual({
      error:
        'Tree "rust" is busy: nodes are being moved, renamed or deleted. Try again in a moment.',
      code: 'tree_busy_structural',
    });
    exclusive();
    expect((await rename({ id: 'lifetimes', name: 'x' })).statusCode).toBe(200);
    expect(locks.isLocked('rust')).toBe(false);
  });

  it('undo round-trip restores the original hierarchy', async () => {
    const before = await hierarchy();
    const { id } = (await rename({ id: 'ownership', name: 'Owning' })).json();
    expect(id).toBe('owning');
    const back = await rename({ id, name: 'ownership' });
    expect(back.json().id).toBe('ownership');
    expect(await hierarchy()).toEqual(before);
  });
});
