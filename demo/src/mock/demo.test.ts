import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../web/src/api/client';
import type { HierarchyNode } from '../../../web/src/api/types';
import { makeDemo, NODE, SMALL_SEED } from './test-helpers';

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

  it('accepts Unicode names and stores them in NFC', async () => {
    const { demo } = makeDemo();
    const name = 'Высоконагруженные приложения, поддержка (Мартин Клеппман).pdf';
    const file = new File(['%PDF'], name.normalize('NFD'));
    expect(await demo.api.uploadSource('t', file)).toEqual({ name, size: 4 });
    expect((await demo.api.listSources('t')).map((s) => s.name)).toContain(name);
    expect((await apiError(demo.api.uploadSource('t', new File(['x'], 'a:b.md')))).status).toBe(
      400,
    );
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

  it('serves PDFs as application/pdf blob URLs that keep working with a page fragment', async () => {
    const { demo } = makeDemo();
    const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n';
    await demo.api.uploadSource('t', new File([pdf], 'guide.pdf'));
    const url = demo.urls.source('t', 'guide.pdf');
    expect(url).toMatch(/^blob:/);
    const plain = await fetch(url);
    expect(plain.headers.get('content-type')).toBe('application/pdf');
    expect(await plain.text()).toBe(pdf);
    // The fragment never reaches the "server": same blob, positioned by the viewer.
    const paged = await fetch(`${url}#page=3`);
    expect(paged.headers.get('content-type')).toBe('application/pdf');
    expect(await paged.text()).toBe(pdf);
    const md = await fetch(demo.urls.source('t', 'notes.md'));
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  it('normalizes source names to NFC like the server', async () => {
    const { demo } = makeDemo();
    const name = 'Дизайн данных (Клеппман).pdf'; // `й` decomposes under NFD
    const nfd = name.normalize('NFD');
    expect(nfd).not.toBe(name);
    await demo.api.uploadSource('t', new File(['%PDF-1.4\n'], name));
    expect(await demo.api.getSourceText('t', nfd)).toBe('%PDF-1.4\n');
    expect(demo.urls.source('t', nfd)).toBe(demo.urls.source('t', name));
    await demo.api.deleteSource('t', nfd);
    expect((await demo.api.listSources('t')).map((s) => s.name)).toEqual(['notes.md']);
  });

  it('user files: blob typed by name, missing file is a text/plain not-found blob', async () => {
    const { demo } = makeDemo();
    demo.vfs.transaction(() => demo.vfs.writeText('t/a/files/report.pdf', '%PDF-1.4\n'));
    const found = await fetch(demo.urls.nodeFile('files', 't', 'a', 'report.pdf'));
    expect(found.headers.get('content-type')).toBe('application/pdf');
    expect(await found.text()).toBe('%PDF-1.4\n');
    const missing = await fetch(demo.urls.nodeFile('files', 't', 'a', 'nope.pdf'));
    expect(missing.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await missing.text()).toBe('Not found: t/a/files/nope.pdf');
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

describe('demo api: stored suggestions stay out of other payloads', () => {
  const seed = {
    ...SMALL_SEED,
    't/a/node.md': NODE('A?', '2026-01-01T00:01:00.000Z', [{ text: 'Next?', up: 0 }]),
    't/a/b/node.md': NODE('B?', '2026-01-01T00:02:00.000Z', []),
  };

  it('chain items have no suggestions property', async () => {
    const { demo } = makeDemo({ seed });
    const chain = await demo.api.getChain('t', 'a/b');
    expect(chain.map((node) => node.id)).toEqual(['a', 'a/b']);
    for (const node of chain) expect(node).not.toHaveProperty('suggestions');
    expect(chain[0]).toMatchObject({ user: 'A?', assistant: 'Answer to A?' });
  });

  it('the hierarchy is unaffected by a suggestions line', async () => {
    const { demo } = makeDemo({ seed });
    const detail = await demo.api.getTree('t');
    expect(ids(detail.nodes)).toEqual(['a', 'a/b', 'c']);
    expect(detail.nodes[0]).toEqual({
      id: 'a',
      name: 'a',
      created: '2026-01-01T00:01:00.000Z',
      children: [{ id: 'a/b', name: 'b', created: '2026-01-01T00:02:00.000Z', children: [] }],
    });
  });

  it('structural routes and suggestion reads never conflict', async () => {
    const { demo } = makeDemo({ seed });
    const next = (target: string, up: number) => [{ text: 'Next?', target, up }];
    // A streaming question holds the shared lock: reads still work.
    const question = await demo.api.startQuestion('t', {
      parentId: 'c',
      text: 'Busy?',
      context: { kind: 'main' },
    });
    expect((await apiError(demo.api.moveNodes('t', ['a/b'], ''))).status).toBe(409);
    expect((await demo.api.getSuggestions('t', 'a')).suggestions).toEqual(next('a', 0));
    await demo.api.cancelQuestion(question.id);
    // No question runs: every structural route succeeds; reads follow the new ids.
    const { deleted } = await demo.api.deleteNodes('t', ['a/b']);
    await demo.api.restoreNodes('t', Object.values(deleted));
    await demo.api.moveNodes('t', ['c'], 'a');
    expect((await demo.api.getSuggestions('t', 'a/c')).suggestions).toEqual(next('a', 1));
    await demo.api.renameNode('t', 'a', 'ay');
    expect((await demo.api.getSuggestions('t', 'ay/c')).suggestions).toEqual(next('ay', 1));
    await demo.api.updateTree('t', { title: 'Renamed' });
    expect((await demo.api.getSuggestions('renamed', 'ay')).suggestions).toEqual(next('ay', 0));
  });
});
