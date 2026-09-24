import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, multipartBody } from './helpers.js';

describe('sources API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
  });
  afterEach(() => ctx.close());

  const upload = (filename: string, content = 'content') =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/sources',
      ...multipartBody('file', filename, content),
    });

  it('uploads, lists, reads and deletes sources', async () => {
    const empty = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources' });
    expect(empty.json()).toEqual({ sources: [] });

    const res = await upload('the-book-ch4.md', '# Chapter 4\nBorrowing.');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: 'the-book-ch4.md', size: 22 });
    expect((await upload('notes.txt', 'plain')).statusCode).toBe(201);
    expect((await upload('paper.pdf', '%PDF-1.4')).statusCode).toBe(201);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources' });
    expect(list.json().sources.map((s: { name: string }) => s.name)).toEqual([
      'notes.txt',
      'paper.pdf',
      'the-book-ch4.md',
    ]);

    const md = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/rust/sources/the-book-ch4.md',
    });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toBe('# Chapter 4\nBorrowing.');
    const pdf = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources/paper.pdf' });
    expect(pdf.headers['content-type']).toBe('application/pdf');

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/trees/rust/sources/notes.txt',
    });
    expect(del.statusCode).toBe(204);
    const gone = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources/notes.txt' });
    expect(gone.statusCode).toBe(404);
    const delAgain = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/trees/rust/sources/notes.txt',
    });
    expect(delAgain.statusCode).toBe(404);
  });

  it('replaces a source with the same name', async () => {
    await upload('a.md', 'v1');
    await upload('a.md', 'v2');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources/a.md' });
    expect(res.body).toBe('v2');
    expect(await readdir(path.join(ctx.treesDir, 'rust', 'sources'))).toEqual(['a.md']);
  });

  it('rejects other extensions and unsafe file names', async () => {
    for (const name of ['image.png', 'script.js', 'noext', '.hidden.md', '..md']) {
      const res = await upload(name);
      expect(res.statusCode, name).toBe(400);
    }
    const list = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources' });
    expect(list.json()).toEqual({ sources: [] });
  });

  it('keeps uploads with path segments inside sources/', async () => {
    const res = await upload('a/../../b.md');
    expect(res.json()).toMatchObject({ name: 'b.md' });
    expect(await readdir(path.join(ctx.treesDir, 'rust', 'sources'))).toEqual(['b.md']);
    expect(await readdir(ctx.treesDir)).toEqual(['rust']);
  });

  it('rejects unsafe names on read and delete', async () => {
    for (const file of ['..%2Ftree.md', '..%2F..%2Fx.md', 'x.png']) {
      const get = await ctx.app.inject({ method: 'GET', url: `/api/trees/rust/sources/${file}` });
      expect(get.statusCode, file).toBe(400);
      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/trees/rust/sources/${file}`,
      });
      expect(del.statusCode, file).toBe(400);
    }
  });

  it('400 without a file, 404 for unknown tree', async () => {
    const noFile = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/sources',
      payload: { x: 1 },
    });
    expect(noFile.statusCode).toBe(400);
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/nope/sources',
      ...multipartBody('file', 'a.md', 'x'),
    });
    expect(unknown.statusCode).toBe(404);
  });
});
