import { access, readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildUserPrompt } from '../src/agent/index.js';
import { EMPTY_TEXT_QUESTION } from '../src/routes/message-input.js';
import { MAX_MESSAGE_FILE_BYTES, parseNodeFile } from '../src/storage/index.js';
import {
  askAndSettle,
  deferred,
  eventKinds,
  expectDone,
  expectFailed,
  type FakeAgentOptions,
  fakeAgent,
  fb2Book,
  type MultipartFileSpec,
  makeApp,
  multipartBody,
  multipartMessage,
  pngBytes,
  settle,
  type TestContext,
  tempEntries,
  tick,
  waitFor,
} from './helpers.js';

const IDLE = { shared: 0, exclusive: false };

describe('POST /api/trees/:tree/questions with files', () => {
  let ctx: TestContext;
  let agent: ReturnType<typeof fakeAgent>;
  afterEach(() => ctx.close());

  async function setup(options: FakeAgentOptions = {}) {
    agent = fakeAgent({ name: 'with-files', ...options });
    ctx = await makeApp(agent);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
  }

  const treeDir = () => path.join(ctx.treesDir, 'rust');
  const treeEntries = async () => (await readdir(treeDir())).sort();

  const send = (
    payload: object | string | null,
    files: MultipartFileSpec[],
    opts: Parameters<typeof multipartMessage>[2] = {},
  ) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/questions',
      ...multipartMessage(payload, files, opts),
    });

  /** Send a multipart question and wait for its outcome. */
  const ask = async (payload: object, files: MultipartFileSpec[]) =>
    settle(ctx, await send(payload, files));

  const getFile = (node: string, name: string, download = false) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/trees/rust/files?node=${encodeURIComponent(node)}&name=${encodeURIComponent(name)}${download ? '&download=1' : ''}`,
    });

  /** Nothing was created or registered, no staging left and the lock is free. */
  async function expectNothingWritten(before = ['tree.md']) {
    expect(await treeEntries()).toEqual(before);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
    expect(agent.calls).toEqual([]);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/questions' });
    expect(list.json().questions).toEqual([]);
    expect(ctx.events.all).toEqual([]);
  }

  it('stores files with the node and reports them in the 202, done and chain', async () => {
    await setup();
    const res = await send({ parentId: '', text: 'Explain these' }, [
      { name: 'notes.md', content: '# Notes', type: 'text/markdown' },
      { name: '', content: pngBytes(), type: 'image/png' },
      { name: 'notes.md', content: '# Other notes' },
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.headers['content-type']).toContain('application/json');
    const files = [
      { name: 'notes-2.md', size: 13, contentType: 'text/markdown; charset=utf-8', kind: 'text' },
      { name: 'notes.md', size: 7, contentType: 'text/markdown; charset=utf-8', kind: 'text' },
      {
        name: 'pasted-image.png',
        size: pngBytes().length,
        contentType: 'image/png',
        kind: 'image',
      },
    ];
    // Staged metadata with the final names, sorted by name, before the answer.
    expect(res.json().question.files).toEqual(files);
    const done = expectDone((await settle(ctx, res)).question);
    expect(done).toMatchObject({ nodeId: 'with-files', attachments: [], files });

    const nodeDir = path.join(treeDir(), 'with-files');
    expect((await readdir(nodeDir)).sort()).toEqual(['files', 'node.md']);
    expect(await readFile(path.join(nodeDir, 'files', 'notes-2.md'), 'utf8')).toBe('# Other notes');
    expect(parseNodeFile(await readFile(path.join(nodeDir, 'node.md'), 'utf8')).user).toBe(
      'Explain these',
    );
    const chain = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/rust/chain?node=with-files',
    });
    expect(chain.json().chain[0].files).toEqual(done.files);
    expect(chain.json().chain[0].attachments).toEqual([]);
    expect(await treeEntries()).toEqual(['tree.md', 'with-files']);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('gives the agent readable staged paths and lists them in the prompt', async () => {
    const seen: string[] = [];
    await setup({
      onAsk: async (input) => {
        for (const file of input.files) {
          await access(path.join(input.treeDir, file.path));
          seen.push(file.path);
        }
      },
    });
    expectDone(
      (
        await ask({ parentId: '', text: 'Q' }, [
          { name: 'shot.png', content: pngBytes() },
          { name: 'Book.fb2', content: fb2Book() },
        ])
      ).question,
    );
    expect(seen).toHaveLength(2);
    for (const file of seen) expect(file).toMatch(/^\.tmp-answer-[^/]+\/files\//);
    expect(seen[1]).toMatch(/files\/Book\.fb2\.md$/);
    const input = agent.calls[0];
    expect(input?.question).toBe('Q');
    expect(seen[0]?.startsWith(`${path.basename(input?.stagingDir ?? '')}/`)).toBe(true);
    const prompt = buildUserPrompt(input?.chain ?? [], input?.question ?? '', input?.files);
    expect(prompt).toContain(`${seen[0]} (image, ${pngBytes().length} bytes)`);
    expect(prompt).toContain(`${seen[1]} (text extracted from Book.fb2,`);
  });

  it('accepts a payload part sent as application/json', async () => {
    await setup();
    const res = await send({ parentId: '', text: 'Q' }, [{ name: 'a.txt', content: 'a' }], {
      payloadType: 'application/json',
    });
    expect(res.statusCode).toBe(202);
    const done = expectDone((await settle(ctx, res)).question);
    expect(done.files.map((f) => f.name)).toEqual(['a.txt']);
  });

  it('extracts e-books; the companion is servable', async () => {
    await setup();
    const done = expectDone(
      (
        await ask({ parentId: '', text: 'Read the book' }, [
          { name: 'tiny.fb2', content: fb2Book() },
        ])
      ).question,
    );
    expect(done.files).toEqual([
      {
        name: 'tiny.fb2',
        size: Buffer.byteLength(fb2Book()),
        contentType: 'application/x-fictionbook+xml',
        kind: 'other',
        text: 'tiny.fb2.md',
      },
    ]);
    const companion = await getFile(done.nodeId, 'tiny.fb2.md');
    expect(companion.statusCode).toBe(200);
    expect(companion.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(companion.body).toContain('<!-- Text extracted by Otago from files/tiny.fb2 -->');
  });

  it('empty text with files: stores "", asks the default question, titled and named from files', async () => {
    await setup();
    const res = await send({ parentId: '', text: '   ' }, [
      { name: 'shot.png', content: pngBytes() },
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json().question).toMatchObject({ text: '', title: 'shot.png' });
    const { nodeId } = expectDone((await settle(ctx, res)).question);
    const node = parseNodeFile(await readFile(path.join(treeDir(), nodeId, 'node.md'), 'utf8'));
    expect(node.user).toBe('');
    expect(agent.calls[0]?.question).toBe(EMPTY_TEXT_QUESTION);
    expect(agent.nameCalls[0]?.question).toBe('Attached files: shot.png');

    const noText = await send({ parentId: '' }, [
      { name: 'b.txt', content: 'b' },
      { name: 'a.txt', content: 'a' },
    ]);
    expect(noText.statusCode).toBe(202);
    expect(noText.json().question.title).toBe('a.txt, b.txt');
    await settle(ctx, noText);
  });

  it('falls back to a name from the file names when naming fails', async () => {
    await setup({ nameError: 'down' });
    const { question } = await ask({ parentId: '', text: '' }, [
      { name: 'diagram.png', content: pngBytes() },
    ]);
    expect(expectDone(question).nodeId).toBe('attached-files-diagram-png');
  });

  it('empty text and no files → 400 empty_message', async () => {
    await setup();
    const res = await send({ parentId: '', text: '' }, []);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Message is empty: type a question or attach a file',
      code: 'empty_message',
    });
    await expectNothingWritten();
    // Text-only multipart works like JSON.
    expectDone((await ask({ parentId: '', text: 'Q' }, [])).question);
  });

  describe('rejections register nothing and leave nothing behind', () => {
    const cases: Array<{
      title: string;
      payload?: object | string | null;
      files: MultipartFileSpec[];
      opts?: Parameters<typeof multipartMessage>[2];
      status: number;
      code?: string;
      error?: string | RegExp;
    }> = [
      {
        title: 'unsupported type',
        files: [
          { name: 'ok.txt', content: 'x' },
          { name: 'notes.docx', content: 'x' },
        ],
        status: 400,
        code: 'unsupported_file_type',
        error: /^Unsupported file type "notes.docx"\. Allowed: \.fb2\.zip, \.md/,
      },
      {
        title: 'too many files',
        files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' })),
        status: 400,
        code: 'too_many_files',
        error: 'Too many files: at most 10 per message',
      },
      {
        title: 'empty file',
        files: [{ name: 'empty.txt', content: '' }],
        status: 400,
        code: 'empty_file',
        error: '"empty.txt" is empty',
      },
      {
        title: 'bad image bytes',
        files: [{ name: 'fake.png', content: 'not a png' }],
        status: 400,
        code: 'unreadable_file',
        error: '"fake.png" is not a valid PNG file',
      },
      {
        title: 'invalid e-book',
        files: [{ name: 'broken.epub', content: 'not a zip' }],
        status: 400,
        code: 'unreadable_file',
        error: /^Cannot read broken\.epub/,
      },
      {
        title: 'missing payload',
        payload: null,
        files: [{ name: 'a.txt', content: 'x' }],
        status: 400,
        code: 'invalid_payload',
      },
      {
        title: 'payload after files',
        files: [{ name: 'a.txt', content: 'x' }],
        opts: { payloadLast: true },
        status: 400,
        code: 'invalid_payload',
      },
      {
        title: 'payload with another name',
        files: [{ name: 'a.txt', content: 'x' }],
        opts: { payloadField: 'body' },
        status: 400,
        code: 'invalid_payload',
      },
      {
        title: 'bad JSON',
        payload: '{nope',
        files: [{ name: 'a.txt', content: 'x' }],
        status: 400,
        code: 'invalid_payload',
      },
      {
        title: 'bad JSON in an application/json part',
        payload: '{nope',
        files: [{ name: 'a.txt', content: 'x' }],
        opts: { payloadType: 'application/json' },
        status: 400,
        code: 'invalid_payload',
      },
      {
        title: 'extra field',
        files: [{ name: 'a.txt', content: 'x' }],
        opts: { extraField: ['foo', 'bar'] },
        status: 400,
        code: 'invalid_payload',
      },
      {
        title: 'file under another field name',
        files: [{ name: 'a.txt', content: 'x', field: 'file' }],
        status: 400,
        code: 'invalid_payload',
      },
      {
        title: 'unknown parent',
        payload: { parentId: 'missing', text: 'Q' },
        files: [{ name: 'a.txt', content: 'x' }],
        status: 404,
        code: 'parent_not_found',
        error: 'Parent node not found: missing',
      },
      {
        title: 'unknown model',
        payload: { parentId: '', text: 'Q', model: 'gpt-4' },
        files: [{ name: 'a.txt', content: 'x' }],
        status: 400,
        error: /^Unknown model "gpt-4"/,
      },
      {
        title: 'side anchor outside the parent chain',
        payload: { parentId: '', text: 'Q', context: { kind: 'side', anchor: 'x' } },
        files: [{ name: 'a.txt', content: 'x' }],
        status: 400,
        error: /^Invalid context/,
      },
    ];

    for (const item of cases) {
      it(item.title, async () => {
        await setup();
        const payload = item.payload === undefined ? { parentId: '', text: 'Q' } : item.payload;
        const res = await send(payload, item.files, item.opts);
        expect(res.statusCode).toBe(item.status);
        expect(res.headers['content-type']).toContain('application/json');
        const body = res.json();
        if (item.code) expect(body.code).toBe(item.code);
        if (typeof item.error === 'string') expect(body.error).toBe(item.error);
        else if (item.error) expect(body.error).toMatch(item.error);
        await expectNothingWritten();
        // The lock is free: a structural change succeeds.
        const move = await ctx.app.inject({
          method: 'POST',
          url: '/api/trees/rust/nodes/move',
          payload: { ids: [], targetParentId: '' },
        });
        expect(move.statusCode).not.toBe(409);
      });
    }

    it('Zod-invalid payload → Invalid input with details', async () => {
      await setup();
      const res = await send({ parentId: 42, text: 'Q' }, [{ name: 'a.txt', content: 'x' }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid input');
      expect(res.json().details).toEqual(expect.any(Array));
      await expectNothingWritten();
    });

    it('file over the cap → 413 file_too_large', async () => {
      await setup();
      const big = Buffer.alloc(MAX_MESSAGE_FILE_BYTES + 1, 0x61);
      const res = await send({ parentId: '', text: 'Q' }, [{ name: 'big.txt', content: big }]);
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        error: '"big.txt" is larger than 20 MB',
        code: 'file_too_large',
      });
      await expectNothingWritten();
    });

    it('invalid JSON body keeps the old shape', async () => {
      await setup();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/trees/rust/questions',
        payload: { parentId: '', text: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Invalid input', details: expect.any(Array) });
    });
  });

  describe('failed questions keep their files outside trees/', () => {
    it('agent failure holds the files; nothing remains under trees/', async () => {
      await setup({ chunks: ['partial', 'more'], failAfter: 1 });
      const { question, events } = await ask({ parentId: '', text: 'Q' }, [
        { name: 'a.txt', content: 'x' },
      ]);
      const failed = expectFailed(question);
      expect(failed).toMatchObject({
        error: { message: 'Agent exploded', code: 'agent_error' },
        files: [{ name: 'a.txt', size: 1 }],
      });
      expect(eventKinds(events).at(-1)).toBe('question:failed');
      expect(await treeEntries()).toEqual(['tree.md']);
      expect(await tempEntries(treeDir())).toEqual([]);
      expect(await readFile(path.join(ctx.heldDir, failed.id, 'files', 'a.txt'), 'utf8')).toBe('x');
      expect(ctx.locks.status('rust')).toEqual(IDLE);
    });

    it('retry moves the held files back and commits them with the node', async () => {
      let attempts = 0;
      const seen: string[][] = [];
      await setup({
        onAsk: async (input) => {
          attempts++;
          for (const file of input.files) await access(path.join(input.treeDir, file.path));
          seen.push(input.files.map((file) => file.path));
          if (attempts === 1) throw new Error('Agent exploded');
        },
      });
      const { question } = await ask({ parentId: '', text: 'Q' }, [
        { name: 'b.md', content: '# b' },
        { name: 'a.txt', content: 'a' },
      ]);
      const failed = expectFailed(question);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/questions/${failed.id}/retry`,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().question.files.map((f: { name: string }) => f.name)).toEqual([
        'a.txt',
        'b.md',
      ]);
      const done = expectDone(await ctx.questions.settled(failed.id));
      expect(done.files.map((f) => f.name)).toEqual(['a.txt', 'b.md']);
      expect(seen).toHaveLength(2);
      for (const paths of seen) {
        expect(paths.map((p) => path.basename(p)).sort()).toEqual(['a.txt', 'b.md']);
      }
      // A new staging folder for the retry.
      expect(seen[1]?.[0]?.split('/')[0]).not.toBe(seen[0]?.[0]?.split('/')[0]);
      expect(await readFile(path.join(treeDir(), done.nodeId, 'files', 'a.txt'), 'utf8')).toBe('a');
      expect(await readdir(ctx.heldDir)).toEqual([]);
      expect(await tempEntries(treeDir())).toEqual([]);
    });

    it('dismiss removes the held files', async () => {
      await setup({ failAfter: 0 });
      const failed = expectFailed(
        (await ask({ parentId: '', text: 'Q' }, [{ name: 'a.txt', content: 'x' }])).question,
      );
      expect(await readdir(ctx.heldDir)).toEqual([failed.id]);
      const res = await ctx.app.inject({ method: 'DELETE', url: `/api/questions/${failed.id}` });
      expect(res.statusCode).toBe(204);
      await waitFor(async () => (await readdir(ctx.heldDir)).length === 0);
    });

    it('a failed question whose parent was moved retries under the new parent', async () => {
      let fail = false;
      const names = ['parent', 'other', 'child'];
      await setup({
        onAsk: () => {
          if (fail) {
            fail = false;
            throw new Error('Agent exploded');
          }
        },
      });
      agent.name = async () => names.shift() ?? 'extra';
      await askAndSettle(ctx, { parentId: '', text: 'parent' });
      await askAndSettle(ctx, { parentId: '', text: 'other' });
      fail = true;
      const failed = expectFailed(
        (
          await ask(
            { parentId: 'parent', text: 'Q', context: { kind: 'side', anchor: 'parent' } },
            [{ name: 'a.txt', content: 'x' }],
          )
        ).question,
      );
      const moved = await ctx.app.inject({
        method: 'POST',
        url: '/api/trees/rust/nodes/move',
        payload: { ids: ['parent'], targetParentId: 'other' },
      });
      expect(moved.statusCode).toBe(200);
      expect(ctx.questions.get(failed.id)).toMatchObject({
        status: 'failed',
        parentId: 'other/parent',
        context: { kind: 'side', anchor: 'other/parent' },
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/questions/${failed.id}/retry`,
      });
      expect(res.statusCode).toBe(202);
      const done = expectDone(await ctx.questions.settled(failed.id));
      expect(done.nodeId).toBe('other/parent/child');
      expect(
        await readFile(path.join(treeDir(), 'other', 'parent', 'child', 'files', 'a.txt'), 'utf8'),
      ).toBe('x');
    });
  });

  it('move while a multipart answer streams → 409 tree_busy_streaming with details', async () => {
    const gate = deferred();
    await setup({ gate: () => gate.promise });
    const res = await send({ parentId: '', text: 'Q' }, [{ name: 'a.txt', content: 'x' }]);
    expect(res.statusCode).toBe(202);
    const move = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/move',
      payload: { ids: ['x'], targetParentId: '' },
    });
    expect(move.statusCode).toBe(409);
    expect(move.json()).toMatchObject({
      code: 'tree_busy_streaming',
      details: { questions: [{ id: res.json().question.id, title: 'Q' }], preparing: 0 },
    });
    gate.open();
    const done = expectDone((await settle(ctx, res)).question);
    expect(done.files.map((f) => f.name)).toEqual(['a.txt']);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('DELETE during the stream → nothing written, no files held', async () => {
    const started = deferred();
    await setup({
      chunks: ['a', 'b', 'c'],
      gate: async () => {
        started.open();
        await new Promise(() => {});
      },
    });
    const res = await send({ parentId: '', text: 'Q' }, [{ name: 'a.txt', content: 'hello' }]);
    await started.promise;
    const { id } = res.json().question;
    const cancel = await ctx.app.inject({ method: 'DELETE', url: `/api/questions/${id}` });
    expect(cancel.statusCode).toBe(204);
    expect(await treeEntries()).toEqual(['tree.md']);
    expect(await readdir(ctx.heldDir)).toEqual([]);
    expect(ctx.locks.status('rust')).toEqual(IDLE);
  });

  it('client disconnect during the upload → nothing written, agent never runs, no entry', async () => {
    await setup();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;
    const boundary = '----otagoabort';
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/trees/rust/questions',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    req.on('error', () => undefined);
    req.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify({ parentId: '', text: 'Q' })}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`,
    );
    req.write(Buffer.alloc(64 * 1024, 0x61));
    await tick(100);
    expect(ctx.locks.status('rust').shared).toBe(1);
    // The upload holds the lock but has no question yet: it counts as preparing.
    const move = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/nodes/move',
      payload: { ids: ['x'], targetParentId: '' },
    });
    expect(move.json()).toMatchObject({
      code: 'tree_busy_streaming',
      details: { questions: [], preparing: 1 },
    });
    const staging = (await treeEntries()).filter((name) => name.startsWith('.tmp-answer-'));
    expect(staging).toHaveLength(1);
    req.destroy();
    await waitFor(() => ctx.locks.status('rust').shared === 0);
    await tick(50);
    await expectNothingWritten();
  });

  it('files are visible to descendants, not to siblings', async () => {
    await setup();
    let names = ['parent', 'child', 'sibling'];
    agent.name = async () => names.shift() ?? 'extra';
    await askAndSettle(ctx, { parentId: '', text: 'root question' });
    const withFiles = await ask({ parentId: 'parent', text: 'Q with file' }, [
      { name: 'notes.md', content: '# n' },
    ]);
    expect(expectDone(withFiles.question).nodeId).toBe('parent/child');

    await askAndSettle(ctx, { parentId: 'parent/child', text: 'follow up' });
    const followInput = agent.calls.at(-1);
    const followPrompt = buildUserPrompt(followInput?.chain ?? [], 'follow up', followInput?.files);
    expect(followPrompt).toContain(
      '<files>\nparent/child/files/notes.md (text, 3 bytes)\n</files>',
    );
    expect(followInput?.files).toEqual([]);

    names = ['sibling'];
    await askAndSettle(ctx, { parentId: 'parent', text: 'sibling' });
    const siblingInput = agent.calls.at(-1);
    const siblingPrompt = buildUserPrompt(
      siblingInput?.chain ?? [],
      'sibling',
      siblingInput?.files,
    );
    expect(siblingPrompt).not.toContain('files/notes.md');
  });

  it('keeps the one-file limit of POST /sources', async () => {
    await setup();
    const body = multipartMessage(null, [
      { name: 'a.md', content: 'a', field: 'file' },
      { name: 'b.md', content: 'b', field: 'file' },
    ]);
    const single = multipartBody('file', 'c.md', 'c');
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/trees/rust/sources', ...single }))
        .statusCode,
    ).toBe(201);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/trees/rust/sources', ...body });
    // Unchanged behaviour: only the first file is taken, the second part is never saved.
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: 'a.md', size: 1 });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources' });
    expect(list.json().sources.map((s: { name: string }) => s.name)).toEqual(['a.md', 'c.md']);
  });

  describe('GET /api/trees/:tree/files', () => {
    async function nodeWithFile() {
      await setup({
        attachments: [
          {
            at: 0,
            save: (s) =>
              s.saveFromBytes({
                name: 'same.txt',
                data: new Uint8Array(Buffer.from('agent bytes')),
                origin: 'inline',
              }),
          },
        ],
      });
      const { question } = await ask({ parentId: '', text: 'Q' }, [
        { name: 'same.txt', content: 'user bytes' },
        { name: 'pic.png', content: pngBytes() },
      ]);
      return expectDone(question).nodeId;
    }

    it('serves a user file inline or as a download with safe headers', async () => {
      const node = await nodeWithFile();
      const res = await getFile(node, 'pic.png');
      expect(res.statusCode).toBe(200);
      expect(res.headers).toMatchObject({
        'content-type': 'image/png',
        'content-length': String(pngBytes().length),
        'content-disposition': `inline; filename="pic.png"; filename*=UTF-8''pic.png`,
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
        'cache-control': 'no-cache',
      });
      expect(res.rawPayload).toEqual(pngBytes());
      const download = await getFile(node, 'same.txt', true);
      expect(download.headers['content-disposition']).toMatch(/^attachment; filename="same.txt"/);
      expect(download.headers['content-type']).toBe('text/plain; charset=utf-8');
    });

    it('keeps user files and agent attachments apart', async () => {
      const node = await nodeWithFile();
      expect((await getFile(node, 'same.txt')).body).toBe('user bytes');
      const attachment = await ctx.app.inject({
        method: 'GET',
        url: `/api/trees/rust/attachments?node=${node}&name=same.txt`,
      });
      expect(attachment.body).toBe('agent bytes');
      const noAttachment = await ctx.app.inject({
        method: 'GET',
        url: `/api/trees/rust/attachments?node=${node}&name=pic.png`,
      });
      expect(noAttachment.statusCode).toBe(404);
    });

    it('404 for unknown nodes or files, 400 for bad names', async () => {
      const node = await nodeWithFile();
      expect((await getFile('missing', 'pic.png')).statusCode).toBe(404);
      const missing = await getFile(node, 'nope.png');
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'File not found: nope.png' });
      for (const bad of ['..', '../node.md', 'a/b.png', '.part-x']) {
        expect((await getFile(node, bad)).statusCode, bad).toBe(400);
      }
      const unknownTree = await ctx.app.inject({
        method: 'GET',
        url: `/api/trees/nope/files?node=${node}&name=pic.png`,
      });
      expect(unknownTree.statusCode).toBe(404);
    });
  });
});
