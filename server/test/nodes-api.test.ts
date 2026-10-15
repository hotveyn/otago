import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Agent, type AgentEvent, TreeLocks } from '../src/agent/index.js';
import { buildApp } from '../src/app.js';
import { createNode, type HierarchyNode } from '../src/storage/index.js';
import {
  askAndSettle,
  eventKinds,
  expectDone,
  expectFailed,
  fakeAgent,
  makeApp,
  makeTempDir,
  TEST_MODELS,
  type TestContext,
} from './helpers.js';

/** An anonymous shared holder (no question): counted as `preparing`. */
const ANONYMOUS_BUSY = { questions: [], preparing: 1 };

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
      details: ANONYMOUS_BUSY,
    });
    const moved = await move({ ids: ['lifetimes'], targetParentId: 'ownership' });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().code).toBe('tree_busy_streaming');
    expect(moved.json().details).toEqual(ANONYMOUS_BUSY);
    release();
    expect((await del({ ids: ['lifetimes'] })).statusCode).toBe(200);
    expect(locks.isLocked('rust')).toBe(false);
  });

  it('409 tree_busy_structural while a move/delete (exclusive) holds the tree', async () => {
    const release = locks.acquireExclusive('rust');
    const deleted = await del({ ids: ['lifetimes'] });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().code).toBe('tree_busy_structural');
    expect(deleted.json()).not.toHaveProperty('details');
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
    expect(streaming.json().details).toEqual(ANONYMOUS_BUSY);
    shared();
    const exclusive = locks.acquireExclusive('rust');
    const structural = await post('restore', { trashIds: [deleted.lifetimes] });
    expect(structural.statusCode).toBe(409);
    expect(structural.json().code).toBe('tree_busy_structural');
    exclusive();
    expect((await post('restore', { trashIds: [deleted.lifetimes] })).statusCode).toBe(200);
    expect(locks.isLocked('rust')).toBe(false);
  });

  it('move names: Unicode names are accepted; NFD keys and values are normalized', async () => {
    const res = await post('move', {
      ids: ['lifetimes'],
      targetParentId: 'ownership',
      names: { lifetimes: 'время-жизни' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toEqual({ lifetimes: 'ownership/время-жизни' });
    const back = await post('move', {
      ids: ['ownership/время-жизни'.normalize('NFD')],
      targetParentId: '',
      names: { ['ownership/время-жизни'.normalize('NFD')]: 'жизнь'.normalize('NFD') },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().moved).toEqual({ 'ownership/время-жизни': 'жизнь' });
    for (const name of ['Жизнь', 'жизнь мира', 'ﬁles']) {
      const bad = await post('move', {
        ids: ['жизнь'],
        targetParentId: 'ownership',
        names: { жизнь: name },
      });
      expect(bad.statusCode, name).toBe(400);
    }
  });

  it('restore accepts NFD trash ids (normalized to NFC)', async () => {
    const renamed = await app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/rename',
      payload: { id: 'lifetimes', name: 'Ёлка' },
    });
    expect(renamed.json().id).toBe('ёлка');
    const { deleted } = (await post('delete', { ids: ['ёлка'.normalize('NFD')] })).json();
    expect(deleted).toEqual({ ёлка: expect.stringMatching(/^ёлка\.deleted-\d{13}$/) });
    const res = await post('restore', { trashIds: [deleted.ёлка.normalize('NFD')] });
    expect(res.statusCode).toBe(200);
    expect(res.json().restored).toEqual({ [deleted.ёлка]: 'ёлка' });
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
      details: ANONYMOUS_BUSY,
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

  it('renames to Unicode names; NFD ids resolve', async () => {
    const res = await rename({ id: 'ownership/borrowing', name: 'Привет' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'ownership/привет',
      name: 'привет',
      renamed: {
        'ownership/borrowing': 'ownership/привет',
        'ownership/borrowing/rules': 'ownership/привет/rules',
      },
    });
    const nfd = await rename({ id: 'ownership/привет'.normalize('NFD'), name: 'Café crème' });
    expect(nfd.json().id).toBe('ownership/café-crème');
    const viaNfd = await chain('ownership/café-crème/rules'.normalize('NFD'));
    expect(viaNfd.statusCode).toBe(200);
    expect(viaNfd.json().chain.map((n: { id: string }) => n.id)).toEqual([
      'ownership',
      'ownership/café-crème',
      'ownership/café-crème/rules',
    ]);
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

describe('structural ops keep retained questions consistent', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  /** Answers everything except questions starting with `fail`. */
  const agent: Agent = {
    async *ask(input): AsyncGenerator<AgentEvent> {
      if (input.question.startsWith('fail')) throw new Error('boom');
      yield { type: 'done', text: `answer ${input.question}`, model: input.model };
    },
    async name(input) {
      return input.question;
    },
  };

  beforeEach(async () => {
    ctx = await makeApp(agent, TEST_MODELS);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    // a/{b}, c
    await askAndSettle(ctx, { parentId: '', text: 'a' });
    await askAndSettle(ctx, { parentId: 'a', text: 'b' });
    await askAndSettle(ctx, { parentId: '', text: 'c' });
  });

  const op = (name: string, body: object) =>
    ctx.app.inject({ method: 'POST', url: `/api/trees/rust/nodes/${name}`, payload: body });

  it('move remaps parentId, anchor and done nodeId (prefix rule) and emits question', async () => {
    const failed = expectFailed(
      (
        await askAndSettle(ctx, {
          parentId: 'a/b',
          text: 'fail here',
          context: { kind: 'side', anchor: 'a' },
        })
      ).question,
    );
    const done = expectDone((await askAndSettle(ctx, { parentId: 'a', text: 'kept' })).question);
    const untouched = expectFailed(
      (await askAndSettle(ctx, { parentId: 'c', text: 'fail c' })).question,
    );
    const before = ctx.events.all.length;

    const res = await op('move', { ids: ['a'], targetParentId: 'c' });
    expect(res.json().moved).toEqual({ a: 'c/a' });
    expect(ctx.questions.get(failed.id)).toMatchObject({
      status: 'failed',
      parentId: 'c/a/b',
      context: { kind: 'side', anchor: 'c/a' },
    });
    expect(ctx.questions.get(done.id)).toMatchObject({ parentId: 'c/a', nodeId: 'c/a/kept' });
    expect(ctx.questions.get(untouched.id)).toEqual(untouched);
    // The setup's own done entries follow too (`a` → node `c/a`, `b` under it); `c` does not.
    const emitted = ctx.events.all.slice(before);
    expect(eventKinds(emitted)).toEqual([
      'question:done',
      'question:done',
      'question:failed',
      'question:done',
    ]);
    expect(emitted.map((e) => (e.event === 'question' ? e.data.question.text : ''))).toEqual([
      'a',
      'b',
      'fail here',
      'kept',
    ]);
    expect(emitted.map((e) => (e.event === 'question' ? e.data.question.parentId : ''))).toEqual([
      '',
      'c/a',
      'c/a/b',
      'c/a',
    ]);
  });

  it('a move out of the anchor subtree resets the anchor to the parent', async () => {
    const failed = expectFailed(
      (
        await askAndSettle(ctx, {
          parentId: 'a/b',
          text: 'fail aside',
          context: { kind: 'side', anchor: 'a' },
        })
      ).question,
    );
    await op('move', { ids: ['a/b'], targetParentId: 'c' });
    expect(ctx.questions.get(failed.id)).toMatchObject({
      parentId: 'c/b',
      context: { kind: 'side', anchor: 'c/b' },
    });
  });

  it('rename remaps retained questions (with a question event)', async () => {
    const failed = expectFailed(
      (await askAndSettle(ctx, { parentId: 'a/b', text: 'fail' })).question,
    );
    const before = ctx.events.all.length;
    const res = await op('rename', { id: 'a', name: 'Привет' });
    expect(res.json().id).toBe('привет');
    expect(ctx.questions.get(failed.id)?.parentId).toBe('привет/b');
    const emitted = ctx.events.all.slice(before);
    expect(eventKinds(emitted)).toEqual(['question:done', 'question:done', 'question:failed']);
    expect(emitted.map((e) => (e.event === 'question' ? e.data.question.text : ''))).toEqual([
      'a',
      'b',
      'fail',
    ]);
    // Retry runs under the remapped parent.
    const retried = await ctx.app.inject({
      method: 'POST',
      url: `/api/questions/${failed.id}/retry`,
    });
    expect(retried.statusCode).toBe(202);
    const settled = await ctx.questions.settled(failed.id);
    // Still fails (same text), but under the new parent: nothing was written.
    expect(expectFailed(settled)).toMatchObject({ attempt: 2, parentId: 'привет/b' });
  });

  it('a same-name rename emits nothing', async () => {
    expectFailed((await askAndSettle(ctx, { parentId: 'a', text: 'fail' })).question);
    const before = ctx.events.all.length;
    await op('rename', { id: 'a', name: 'A' });
    expect(ctx.events.all.length).toBe(before);
  });

  it('delete removes questions under the deleted subtree; restore does not bring them back', async () => {
    const underB = expectFailed(
      (await askAndSettle(ctx, { parentId: 'a/b', text: 'fail b' })).question,
    );
    const onA = expectFailed((await askAndSettle(ctx, { parentId: 'a', text: 'fail a' })).question);
    const doneUnderA = expectDone(
      (await askAndSettle(ctx, { parentId: 'a', text: 'kept' })).question,
    );
    const elsewhere = expectFailed(
      (await askAndSettle(ctx, { parentId: 'c', text: 'fail c' })).question,
    );
    const before = ctx.events.all.length;

    const { deleted } = (await op('delete', { ids: ['a'] })).json();
    const removed = ctx.events.all.slice(before);
    expect(removed.map((e) => e.data)).toEqual(
      expect.arrayContaining([
        { id: underB.id, tree: 'rust', reason: 'deleted' },
        { id: onA.id, tree: 'rust', reason: 'deleted' },
        { id: doneUnderA.id, tree: 'rust', reason: 'deleted', nodeId: 'a/kept' },
        // The setup's done entries of `a` itself and of `a/b`.
        expect.objectContaining({ reason: 'deleted', nodeId: 'a' }),
        expect.objectContaining({ reason: 'deleted', nodeId: 'a/b' }),
      ]),
    );
    expect(removed).toHaveLength(5);
    expect(ctx.questions.get(elsewhere.id)).toEqual(elsewhere);

    const restored = await op('restore', { trashIds: [deleted.a] });
    expect(restored.statusCode).toBe(200);
    expect(
      ctx.questions
        .list()
        .map((q) => q.text)
        .sort(),
    ).toEqual(['c', 'fail c']);
    expect(ctx.events.all.length).toBe(before + 5);
  });

  it('409 details list the running question that blocks a structural op', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowCtx = await makeApp(fakeAgent({ gate: () => gate }), TEST_MODELS);
    try {
      await slowCtx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Go' } });
      const started = await slowCtx.app.inject({
        method: 'POST',
        url: '/api/trees/go/questions',
        payload: {
          parentId: '',
          text: '  Why\n  goroutines? ',
          context: { kind: 'side', anchor: '' },
        },
      });
      const { id, title } = started.json().question;
      expect(title).toBe('Why');
      const res = await slowCtx.app.inject({
        method: 'POST',
        url: '/api/trees/go/nodes/restore',
        payload: { trashIds: ['x.deleted-1759000000000'] },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().details).toEqual({
        questions: [
          {
            id,
            tree: 'go',
            parentId: '',
            context: { kind: 'side', anchor: '' },
            title: 'Why',
            status: 'streaming',
          },
        ],
        preparing: 0,
      });
      release();
      await slowCtx.questions.settled(id);
    } finally {
      await slowCtx.close();
    }
  });
});
