import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../web/src/api/client';
import type { HierarchyNode } from '../../../web/src/api/types';
import { makeDemo } from './test-helpers';

const ids = (nodes: HierarchyNode[]): string[] =>
  nodes.flatMap((node) => [node.id, ...ids(node.children)]);

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('demo api: trees', () => {
  it('lists, creates and reads trees', async () => {
    const { demo } = makeDemo();
    expect((await demo.api.listTrees()).map((tree) => tree.id)).toEqual(['t']);
    const created = await demo.api.createTree({ title: 'T', instructions: ' Hi ' });
    expect(created).toMatchObject({ id: 't-2', title: 'T', instructions: 'Hi' });
    const detail = await demo.api.getTree('t');
    expect(ids(detail.nodes)).toEqual(['a', 'a/b', 'c']);
    expect((await apiError(demo.api.getTree('nope'))).code).toBe('tree_not_found');
  });

  it('renames the tree folder on a title change and reports the previous id', async () => {
    const { demo } = makeDemo();
    const result = await demo.api.updateTree('t', { title: 'Rust basics' });
    expect(result).toMatchObject({ id: 'rust-basics', previous: { id: 't', title: 'T' } });
    expect((await demo.api.getTree('rust-basics')).nodes).toHaveLength(2);
    expect((await apiError(demo.api.getTree('t'))).status).toBe(404);
    const same = await demo.api.updateTree('rust-basics', { instructions: 'New' });
    expect(same).toMatchObject({ id: 'rust-basics', instructions: 'New' });
  });

  it('reads the chain with node files', async () => {
    const { demo } = makeDemo();
    demo.vfs.transaction(() => demo.vfs.writeText('t/a/b/attachments/table.csv', 'x,y\n1,2\n'));
    const chain = await demo.api.getChain('t', 'a/b');
    expect(chain.map((node) => node.id)).toEqual(['a', 'a/b']);
    expect(chain[1]).toMatchObject({ user: 'B?', assistant: 'Answer to B?', files: [] });
    expect(chain[1]?.attachments).toEqual([
      { name: 'table.csv', size: 8, contentType: 'text/csv; charset=utf-8', kind: 'table' },
    ]);
    expect(await demo.api.getAttachmentText('t', 'a/b', 'table.csv')).toBe('x,y\n1,2\n');
    expect((await apiError(demo.api.getChain('t', 'a/zz'))).status).toBe(404);
  });
});

describe('demo api: nodes', () => {
  it('soft-deletes and restores, picking -2 when the name was taken', async () => {
    const { demo } = makeDemo();
    const { deleted, nodes } = await demo.api.deleteNodes('t', ['a', 'a/b']);
    expect(Object.keys(deleted)).toEqual(['a']);
    expect(deleted.a).toMatch(/^a\.deleted-\d{13}$/);
    expect(ids(nodes)).toEqual(['c']);
    // Another node takes the name meanwhile.
    await demo.api.renameNode('t', 'c', 'A');
    const restored = await demo.api.restoreNodes('t', [deleted.a as string]);
    expect(restored.restored[deleted.a as string]).toBe('a-2');
    expect(ids(restored.nodes)).toEqual(['a-2', 'a-2/b', 'a']);
    expect((await apiError(demo.api.restoreNodes('t', [deleted.a as string]))).code).toBe(
      'trash_not_found',
    );
  });

  it('moves with names and rejects moving into a descendant', async () => {
    const { demo } = makeDemo();
    const { moved } = await demo.api.moveNodes('t', ['c'], 'a', { c: 'b' });
    expect(moved).toEqual({ c: 'a/b-2' });
    expect((await apiError(demo.api.moveNodes('t', ['a'], 'a/b'))).status).toBe(400);
    expect((await apiError(demo.api.moveNodes('t', ['a'], 'zz'))).code).toBe('parent_not_found');
    expect((await apiError(demo.api.moveNodes('t', ['zz'], ''))).code).toBe('node_not_found');
  });

  it('renames with Unicode names and maps every descendant', async () => {
    const { demo } = makeDemo();
    const result = await demo.api.renameNode('t', 'a', 'Заимствование и ссылки');
    expect(result.id).toBe('заимствование-и-ссылки');
    expect(result.renamed).toEqual({
      a: 'заимствование-и-ссылки',
      'a/b': 'заимствование-и-ссылки/b',
    });
    const same = await demo.api.renameNode('t', 'c', 'c');
    expect(same.renamed).toEqual({ c: 'c' });
  });
});

describe('demo api: sources and urls', () => {
  it('uploads, lists, reads and deletes sources', async () => {
    const { demo } = makeDemo();
    const file = new File(['# Ch 1\n'], 'chapter-1.md', { type: 'text/markdown' });
    expect(await demo.api.uploadSource('t', file)).toEqual({ name: 'chapter-1.md', size: 7 });
    expect((await demo.api.listSources('t')).map((s) => s.name)).toEqual([
      'chapter-1.md',
      'notes.md',
    ]);
    expect(await demo.api.getSourceText('t', 'chapter-1.md')).toBe('# Ch 1\n');
    await demo.api.deleteSource('t', 'chapter-1.md');
    expect((await apiError(demo.api.getSourceText('t', 'chapter-1.md'))).status).toBe(404);
  });

  it('rejects e-books and oversized uploads', async () => {
    const { demo } = makeDemo();
    const book = new File(['x'], 'book.epub');
    expect((await apiError(demo.api.uploadSource('t', book))).message).toMatch(/demo/);
    const big = new File([new Uint8Array(600 * 1024)], 'big.pdf');
    expect((await apiError(demo.api.uploadSource('t', big))).status).toBe(413);
  });

  it('reports a full storage as 413 and keeps the old state', async () => {
    const { demo, storage } = makeDemo();
    storage.failNextSave();
    const error = await apiError(demo.api.createTree({ title: 'Big' }));
    expect(error.status).toBe(413);
    expect((await demo.api.listTrees()).map((tree) => tree.id)).toEqual(['t']);
  });

  it('serves files as blob URLs, new URL when the file changes', () => {
    const { demo } = makeDemo();
    const first = demo.urls.source('t', 'notes.md');
    expect(first).toMatch(/^blob:/);
    expect(demo.urls.source('t', 'notes.md')).toBe(first);
    demo.vfs.transaction(() => demo.vfs.writeText('t/sources/notes.md', '# Changed\n'));
    expect(demo.urls.source('t', 'notes.md')).not.toBe(first);
  });
});
