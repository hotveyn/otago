import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, AttachmentStaging } from '../src/agent/index.js';
import { parseNodeFile, serializeNodeFile } from '../src/storage/index.js';
import { type FakeAgentOptions, fakeAgent, makeApp, parseSse, TEST_MODELS } from './helpers.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const saveSvg = (s: AttachmentStaging) =>
  s.saveFromBytes({ name: 'memory-layout.svg', data: Buffer.from(svg), origin: 'inline' });
const savePng = (s: AttachmentStaging) =>
  s.saveFromBytes({ name: 'pic.png', data: png, origin: 'inline' });

let fileServer: http.Server;
let fileBase: string;

beforeAll(async () => {
  fileServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
  });
  await new Promise<void>((resolve) => fileServer.listen(0, '127.0.0.1', resolve));
  fileBase = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => fileServer.close(resolve));
});

describe('answers with attachments', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  afterEach(() => ctx.close());

  async function setup(options: FakeAgentOptions | Agent, extra = {}) {
    const agent = 'ask' in options ? options : fakeAgent(options);
    ctx = await makeApp(agent, TEST_MODELS, extra);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    return agent;
  }

  const post = (payload: object) =>
    ctx.app.inject({ method: 'POST', url: '/api/trees/rust/messages', payload });
  const treeDir = () => path.join(ctx.treesDir, 'rust');
  const getAttachment = (query: string, method: 'GET' | 'HEAD' = 'GET') =>
    ctx.app.inject({ method, url: `/api/trees/rust/attachments?${query}` });

  /** Every `.tmp-*` entry anywhere in the tree. */
  async function tempEntries(dir = treeDir()): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.tmp-')) found.push(entry.name);
      else if (entry.isDirectory()) found.push(...(await tempEntries(path.join(dir, entry.name))));
    }
    return found;
  }

  it('streams attachment events and commits files with the node', async () => {
    await setup({
      chunks: ['See ', 'the chart.'],
      name: 'layout',
      attachments: [
        { at: 1, save: saveSvg },
        { at: 2, save: savePng },
      ],
    });
    const res = await post({ parentId: '', text: 'Draw memory' });
    const events = parseSse(res.body);
    expect(events.map((e) => [e.event, (e.data as { status?: string }).status])).toEqual([
      ['chunk', undefined],
      ['attachment', 'saving'],
      ['attachment', 'ready'],
      ['chunk', undefined],
      ['attachment', 'saving'],
      ['attachment', 'ready'],
      ['done', undefined],
    ]);
    expect(events[1]?.data).toEqual({
      status: 'saving',
      key: expect.any(String),
      requestedName: 'memory-layout.svg',
      origin: 'inline',
    });
    expect(events[2]?.data).toEqual({
      status: 'ready',
      key: (events[1]?.data as { key?: string } | undefined)?.key,
      attachment: {
        name: 'memory-layout.svg',
        size: svg.length,
        contentType: 'image/svg+xml',
        kind: 'svg',
        origin: 'inline',
      },
    });
    expect(events.at(-1)?.data).toEqual({
      nodeId: 'layout',
      attachments: [
        { name: 'memory-layout.svg', size: svg.length, contentType: 'image/svg+xml', kind: 'svg' },
        { name: 'pic.png', size: png.length, contentType: 'image/png', kind: 'image' },
      ],
      files: [],
    });

    const nodeDir = path.join(treeDir(), 'layout');
    expect((await readdir(nodeDir)).sort()).toEqual(['attachments', 'node.md']);
    expect(await readFile(path.join(nodeDir, 'attachments', 'memory-layout.svg'), 'utf8')).toBe(
      svg,
    );
    expect(await readFile(path.join(nodeDir, 'attachments', 'pic.png'))).toEqual(png);
    expect(parseNodeFile(await readFile(path.join(nodeDir, 'node.md'), 'utf8'))).toMatchObject({
      user: 'Draw memory',
      assistant: 'See the chart.',
    });
    expect(await tempEntries()).toEqual([]);
  });

  it('suffixes duplicate names within one answer', async () => {
    await setup({
      attachments: [
        { at: 0, save: saveSvg },
        { at: 1, save: saveSvg },
      ],
    });
    const done = parseSse((await post({ parentId: '', text: 'Q' })).body).at(-1);
    expect(
      (done?.data as { attachments?: Array<{ name: string }> } | undefined)?.attachments?.map(
        (a) => a.name,
      ),
    ).toEqual(['memory-layout-2.svg', 'memory-layout.svg']);
  });

  it('tool failure → failed event, answer still completes without attachments/', async () => {
    await setup({
      name: 'plain',
      attachments: [
        {
          at: 1,
          save: (s) => s.saveFromBytes({ name: 'x.txt', data: Buffer.alloc(0), origin: 'inline' }),
        },
      ],
    });
    const events = parseSse((await post({ parentId: '', text: 'Q' })).body);
    expect(events.filter((e) => e.event === 'attachment').map((e) => e.data)).toEqual([
      { status: 'saving', key: expect.any(String), requestedName: 'x.txt', origin: 'inline' },
      {
        status: 'failed',
        key: expect.any(String),
        requestedName: 'x.txt',
        message: 'Empty content',
      },
    ]);
    expect(events.at(-1)).toEqual({
      event: 'done',
      data: { nodeId: 'plain', attachments: [], files: [] },
    });
    expect(await readdir(path.join(treeDir(), 'plain'))).toEqual(['node.md']);
  });

  it('agent failure after saving → error, no node, no staging left', async () => {
    await setup({ chunks: ['a', 'b'], failAfter: 1, attachments: [{ at: 1, save: saveSvg }] });
    const events = parseSse((await post({ parentId: '', text: 'Q' })).body);
    expect(events.at(-1)).toEqual({ event: 'error', data: { message: 'Agent exploded' } });
    expect(events.some((e) => (e.data as { status?: string }).status === 'ready')).toBe(true);
    expect(await readdir(treeDir())).toEqual(['tree.md']);
  });

  it('client disconnect → no node and staging removed', async () => {
    let reached!: () => void;
    const saved = new Promise<void>((resolve) => {
      reached = resolve;
    });
    await setup({
      chunks: ['a', 'b', 'c'],
      attachments: [
        {
          at: 1,
          save: async (s) => {
            await saveSvg(s);
            reached();
          },
        },
      ],
      gate: () => new Promise((resolve) => setTimeout(resolve, 50)),
    });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/trees/rust/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: '', text: 'Q' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    await saved;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readdir(treeDir())).toEqual(['tree.md']);
  });

  it('downloads URLs when private URLs are allowed', async () => {
    await setup(
      {
        name: 'img',
        attachments: [{ at: 0, save: (s) => s.saveFromUrl({ url: `${fileBase}/` }) }],
      },
      { allowPrivateUrls: true },
    );
    const events = parseSse((await post({ parentId: '', text: 'Q' })).body);
    expect(events[0]?.data).toMatchObject({ status: 'saving', origin: 'url' });
    expect(events.at(-1)?.data).toEqual({
      nodeId: 'img',
      attachments: [
        { name: 'attachment.png', size: png.length, contentType: 'image/png', kind: 'image' },
      ],
      files: [],
    });
  });

  it('blocks private URLs by default, answer continues', async () => {
    await setup({
      name: 'img',
      attachments: [{ at: 0, save: (s) => s.saveFromUrl({ url: `${fileBase}/a.png` }) }],
    });
    const events = parseSse((await post({ parentId: '', text: 'Q' })).body);
    expect(events[1]?.data).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Blocked private address'),
    });
    expect(events.at(-1)).toEqual({
      event: 'done',
      data: { nodeId: 'img', attachments: [], files: [] },
    });
  });

  it('chain lists attachments and passes them to follow-up questions', async () => {
    const agent = await setup({ name: 'topic', attachments: [{ at: 0, save: saveSvg }] });
    await post({ parentId: '', text: 'Q1' });
    // Hand-written legacy node without attachments.
    await mkdir(path.join(treeDir(), 'legacy'));
    await writeFile(
      path.join(treeDir(), 'legacy', 'node.md'),
      serializeNodeFile({
        created: '2026-01-01T00:00:00.000Z',
        model: 'm',
        user: 'U',
        assistant: 'A',
      }),
    );

    const chain = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/chain?node=topic' });
    expect(chain.json().chain[0].attachments).toEqual([
      { name: 'memory-layout.svg', size: svg.length, contentType: 'image/svg+xml', kind: 'svg' },
    ]);
    const legacy = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/rust/chain?node=legacy',
    });
    expect(legacy.json().chain[0].attachments).toEqual([]);

    await post({ parentId: 'topic', text: 'Q2' });
    expect((agent as ReturnType<typeof fakeAgent>).calls[1]?.chain[0]?.attachments).toEqual([
      expect.objectContaining({ name: 'memory-layout.svg' }),
    ]);
  });

  it('serves committed attachments with safe headers', async () => {
    await setup({ name: 'topic', attachments: [{ at: 0, save: saveSvg }] });
    await post({ parentId: '', text: 'Q' });

    const res = await getAttachment('node=topic&name=memory-layout.svg');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(svg);
    expect(res.headers).toMatchObject({
      'content-type': 'image/svg+xml',
      'content-length': String(svg.length),
      'content-disposition': `inline; filename="memory-layout.svg"; filename*=UTF-8''memory-layout.svg`,
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'no-cache',
    });

    const download = await getAttachment('node=topic&name=memory-layout.svg&download=1');
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename="memory-layout.svg"/,
    );

    const head = await getAttachment('node=topic&name=memory-layout.svg', 'HEAD');
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(svg.length));
    expect(head.body).toBe('');
  });

  it('attachment route errors', async () => {
    await setup({ name: 'topic', attachments: [{ at: 0, save: saveSvg }] });
    await post({ parentId: '', text: 'Q' });
    expect((await getAttachment('node=topic&name=missing.svg')).statusCode).toBe(404);
    expect((await getAttachment('node=topic&name=..%2Fnode.md')).statusCode).toBe(400);
    expect((await getAttachment('node=topic&name=.hidden')).statusCode).toBe(400);
    expect((await getAttachment('node=nope&name=memory-layout.svg')).statusCode).toBe(404);
    expect((await getAttachment('node=..%2Fx&name=memory-layout.svg')).statusCode).toBe(400);
    expect((await getAttachment('node=&name=memory-layout.svg')).statusCode).toBe(400);
    expect((await getAttachment('node=topic&name=a.svg&download=yes')).statusCode).toBe(400);
    const otherTree = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/nope/attachments?node=topic&name=memory-layout.svg',
    });
    expect(otherTree.statusCode).toBe(404);
  });

  it('reserves `attachments` as a node name at every level', async () => {
    await setup({ name: 'attachments' });
    const root = parseSse((await post({ parentId: '', text: 'Q' })).body).at(-1);
    expect(root?.data).toMatchObject({ nodeId: 'attachments-2' });
    const child = parseSse((await post({ parentId: 'attachments-2', text: 'Q' })).body).at(-1);
    expect(child?.data).toMatchObject({ nodeId: 'attachments-2/attachments-2' });

    // The hierarchy never shows the reserved folder, only the suffixed nodes.
    const tree = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust' });
    const ids = (nodes: Array<{ id: string; children: unknown[] }>): string[] =>
      nodes.flatMap((n) => [n.id, ...ids(n.children as never)]);
    expect(ids(tree.json().nodes).sort()).toEqual(['attachments-2', 'attachments-2/attachments-2']);
  });

  it('attachments move and get deleted with their node', async () => {
    await setup({ name: 'topic', attachments: [{ at: 0, save: saveSvg }] });
    await post({ parentId: '', text: 'Q1' });
    await post({ parentId: '', text: 'Q2' }); // topic-2
    const move = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/move',
      payload: { ids: ['topic'], targetParentId: 'topic-2' },
    });
    expect(move.json().moved).toEqual({ topic: 'topic-2/topic' });
    expect(await readdir(path.join(treeDir(), 'topic-2', 'topic', 'attachments'))).toEqual([
      'memory-layout.svg',
    ]);
    expect((await getAttachment('node=topic-2/topic&name=memory-layout.svg')).statusCode).toBe(200);

    await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/delete',
      payload: { ids: ['topic-2'] },
    });
    expect(await readdir(treeDir())).toEqual(['tree.md']);
  });

  it('409 for node management while an attachment save is pending', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await setup({
      attachments: [
        {
          at: 0,
          save: async (s) => {
            await gate;
            return saveSvg(s);
          },
        },
      ],
    });
    const first = post({ parentId: '', text: 'Q' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const del = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/delete',
      payload: { ids: ['x'] },
    });
    expect(del.statusCode).toBe(409);
    finish();
    expect(parseSse((await first).body).at(-1)?.event).toBe('done');
  });
});
