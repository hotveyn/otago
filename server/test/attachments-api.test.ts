import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, AttachmentStaging } from '../src/agent/index.js';
import type { AttachmentEventData, RegistryEvent } from '../src/questions/index.js';
import { parseNodeFile, serializeNodeFile } from '../src/storage/index.js';
import {
  askAndSettle,
  eventKinds,
  expectDone,
  expectFailed,
  type FakeAgentOptions,
  fakeAgent,
  makeApp,
  postQuestion,
  TEST_MODELS,
  type TestContext,
  tempEntries,
} from './helpers.js';

/** `event` payloads of the attachment events (asserting the attempt). */
function attachmentEvents(events: RegistryEvent[], attempt = 1): AttachmentEventData['event'][] {
  return events.flatMap((e) => {
    if (e.event !== 'attachment') return [];
    expect(e.data.attempt).toBe(attempt);
    return [e.data.event];
  });
}

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
  let ctx: TestContext;
  afterEach(() => ctx.close());

  async function setup(options: FakeAgentOptions | Agent, extra = {}) {
    const agent = 'ask' in options ? options : fakeAgent(options);
    ctx = await makeApp(agent, TEST_MODELS, extra);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    return agent;
  }

  const post = (payload: object) => askAndSettle(ctx, payload);
  const treeDir = () => path.join(ctx.treesDir, 'rust');
  const getAttachment = (query: string, method: 'GET' | 'HEAD' = 'GET') =>
    ctx.app.inject({ method, url: `/api/trees/rust/attachments?${query}` });

  it('streams attachment events and commits files with the node', async () => {
    await setup({
      chunks: ['See ', 'the chart.'],
      name: 'layout',
      attachments: [
        { at: 1, save: saveSvg },
        { at: 2, save: savePng },
      ],
    });
    const { question, events } = await post({ parentId: '', text: 'Draw memory' });
    // Every attachment event precedes `naming` (sealed first).
    expect(eventKinds(events)).toEqual([
      'question:streaming',
      'chunk',
      'attachment:saving',
      'attachment:ready',
      'chunk',
      'attachment:saving',
      'attachment:ready',
      'question:naming',
      'question:done',
    ]);
    const attachments = attachmentEvents(events);
    expect(attachments[0]).toEqual({
      status: 'saving',
      key: expect.any(String),
      requestedName: 'memory-layout.svg',
      origin: 'inline',
    });
    expect(attachments[1]).toEqual({
      status: 'ready',
      key: attachments[0]?.key,
      attachment: {
        name: 'memory-layout.svg',
        size: svg.length,
        contentType: 'image/svg+xml',
        kind: 'svg',
        origin: 'inline',
      },
    });
    expect(expectDone(question)).toMatchObject({
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
    expect(await tempEntries(treeDir())).toEqual([]);
  });

  it('suffixes duplicate names within one answer', async () => {
    await setup({
      attachments: [
        { at: 0, save: saveSvg },
        { at: 1, save: saveSvg },
      ],
    });
    const { question } = await post({ parentId: '', text: 'Q' });
    expect(expectDone(question).attachments.map((a) => a.name)).toEqual([
      'memory-layout-2.svg',
      'memory-layout.svg',
    ]);
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
    const { question, events } = await post({ parentId: '', text: 'Q' });
    expect(attachmentEvents(events)).toEqual([
      { status: 'saving', key: expect.any(String), requestedName: 'x.txt', origin: 'inline' },
      {
        status: 'failed',
        key: expect.any(String),
        requestedName: 'x.txt',
        message: 'Empty content',
      },
    ]);
    expect(expectDone(question)).toMatchObject({ nodeId: 'plain', attachments: [], files: [] });
    expect(await readdir(path.join(treeDir(), 'plain'))).toEqual(['node.md']);
  });

  it('agent failure after saving → failed, no node, no staging left', async () => {
    await setup({ chunks: ['a', 'b'], failAfter: 1, attachments: [{ at: 1, save: saveSvg }] });
    const { question, events } = await post({ parentId: '', text: 'Q' });
    expect(expectFailed(question).error).toEqual({
      message: 'Agent exploded',
      code: 'agent_error',
    });
    expect(attachmentEvents(events).some((e) => e.status === 'ready')).toBe(true);
    // The live state of the failed attempt keeps the attachment progress (display only).
    expect(ctx.questions.detail(question?.id ?? '')?.live?.attachments).toMatchObject([
      { status: 'ready', attachment: { name: 'memory-layout.svg' } },
    ]);
    expect(await readdir(treeDir())).toEqual(['tree.md']);
  });

  it('cancel → no node and staging removed', async () => {
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
    const res = await postQuestion(ctx, { parentId: '', text: 'Q' });
    const { id } = res.json().question;
    await saved;
    expect(ctx.questions.detail(id)?.live?.attachments).toMatchObject([
      { status: 'ready', attachment: { name: 'memory-layout.svg' } },
    ]);
    const cancel = await ctx.app.inject({ method: 'DELETE', url: `/api/questions/${id}` });
    expect(cancel.statusCode).toBe(204);
    expect(await readdir(treeDir())).toEqual(['tree.md']);
    expect(await tempEntries(treeDir())).toEqual([]);
  });

  it('downloads URLs when private URLs are allowed', async () => {
    await setup(
      {
        name: 'img',
        attachments: [{ at: 0, save: (s) => s.saveFromUrl({ url: `${fileBase}/` }) }],
      },
      { allowPrivateUrls: true },
    );
    const { question, events } = await post({ parentId: '', text: 'Q' });
    expect(attachmentEvents(events)[0]).toMatchObject({ status: 'saving', origin: 'url' });
    expect(expectDone(question)).toMatchObject({
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
    const { question, events } = await post({ parentId: '', text: 'Q' });
    expect(attachmentEvents(events)[1]).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Blocked private address'),
    });
    expect(expectDone(question)).toMatchObject({ nodeId: 'img', attachments: [], files: [] });
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
    const root = await post({ parentId: '', text: 'Q' });
    expect(expectDone(root.question).nodeId).toBe('attachments-2');
    const child = await post({ parentId: 'attachments-2', text: 'Q' });
    expect(expectDone(child.question).nodeId).toBe('attachments-2/attachments-2');

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

    const deleted = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/delete',
      payload: { ids: ['topic-2'] },
    });
    // Soft delete: the subtree (attachments included) travels into the trash folder.
    const trashId: string = deleted.json().deleted['topic-2'];
    expect(await readdir(treeDir())).toEqual([trashId, 'tree.md'].sort());
    expect(await readdir(path.join(treeDir(), trashId, 'topic', 'attachments'))).toEqual([
      'memory-layout.svg',
    ]);
    expect((await getAttachment('node=topic-2/topic&name=memory-layout.svg')).statusCode).toBe(404);
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
    const first = await postQuestion(ctx, { parentId: '', text: 'Q' });
    const { id } = first.json().question;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const del = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/delete',
      payload: { ids: ['x'] },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().details).toEqual({
      questions: [
        {
          id,
          tree: 'rust',
          parentId: '',
          context: { kind: 'main' },
          title: 'Q',
          status: 'streaming',
        },
      ],
      preparing: 0,
    });
    finish();
    expect((await ctx.questions.settled(id))?.status).toBe('done');
  });
});
