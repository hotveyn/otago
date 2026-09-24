import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentError } from '../src/errors.js';
import { uniqueFileName } from '../src/storage/fs-utils.js';
import {
  ATTACHMENT_NAME_PATTERN,
  type AttachmentEvent,
  attachmentContentTypeOf,
  attachmentKindOf,
  attachmentPath,
  createAnswerStaging,
  createNode,
  listAttachments,
  nodeIdSegments,
  readChain,
  readHierarchy,
  sanitizeAttachmentName,
  sweepStaleStaging,
} from '../src/storage/index.js';
import { makeTempDir } from './helpers.js';

const bytes = (text: string) => new Uint8Array(Buffer.from(text));

describe('sanitizeAttachmentName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['a/b\\c.svg', 'c.svg'],
    ['Мой файл.csv', 'attachment.csv'],
    ['my chart  v2.svg', 'my-chart-v2.svg'],
    ['...hidden.txt', 'hidden.txt'],
    ['.bashrc', 'bashrc'],
    ['Café crème.png', 'Cafe-creme.png'],
    ['a..b....c.txt', 'a.b.c.txt'],
    ['file.', 'file'],
    ['-_-name.md', 'name.md'],
    ['', 'attachment'],
    ['   ', 'attachment'],
    ['<script>.html', 'script.html'],
  ])('%j → %s', (raw, expected) => {
    expect(sanitizeAttachmentName(raw)).toBe(expected);
  });

  it('trims long names to 120 chars and keeps the extension', () => {
    const name = sanitizeAttachmentName(`${'a'.repeat(300)}.svg`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.svg')).toBe(true);
  });

  it('always matches the name pattern', () => {
    for (const raw of ['../x', '..', '.', '/', '\\\\', 'ok.tar.gz', 'x'.repeat(500), '日本.pdf']) {
      const name = sanitizeAttachmentName(raw);
      expect(name).toMatch(ATTACHMENT_NAME_PATTERN);
      expect(name).not.toContain('..');
    }
  });
});

describe('uniqueFileName', () => {
  it('adds the suffix before the last extension', () => {
    const taken = new Set<string>();
    const take = (name: string) => {
      const result = uniqueFileName(taken, name);
      taken.add(result);
      return result;
    };
    expect([take('chart.svg'), take('chart.svg'), take('chart.svg')]).toEqual([
      'chart.svg',
      'chart-2.svg',
      'chart-3.svg',
    ]);
    expect([take('README'), take('README')]).toEqual(['README', 'README-2']);
    expect([take('archive.tar.gz'), take('archive.tar.gz')]).toEqual([
      'archive.tar.gz',
      'archive.tar-2.gz',
    ]);
  });

  it('keeps the result within 120 chars', () => {
    const long = `${'a'.repeat(116)}.svg`;
    expect(uniqueFileName(new Set([long]), long)).toHaveLength(120);
  });
});

describe('attachment kinds and content types', () => {
  it.each([
    ['a.png', 'image', 'image/png'],
    ['a.JPG', 'image', 'image/jpeg'],
    ['a.webp', 'image', 'image/webp'],
    ['a.svg', 'svg', 'image/svg+xml'],
    ['a.csv', 'table', 'text/csv; charset=utf-8'],
    ['a.tsv', 'table', 'text/tab-separated-values; charset=utf-8'],
    ['a.md', 'text', 'text/markdown; charset=utf-8'],
    ['a.json', 'text', 'application/json; charset=utf-8'],
    ['a.py', 'text', 'text/plain; charset=utf-8'],
    ['a.html', 'text', 'text/html; charset=utf-8'],
    ['a.pdf', 'pdf', 'application/pdf'],
    ['a.zip', 'other', 'application/zip'],
    ['a.xyz', 'other', 'application/octet-stream'],
    ['README', 'other', 'application/octet-stream'],
  ])('%s → %s / %s', (name, kind, type) => {
    expect(attachmentKindOf(name)).toBe(kind);
    expect(attachmentContentTypeOf(name)).toBe(type);
  });
});

describe('attachment storage', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });
  afterEach(() => cleanup());

  it('lists regular, well-named files sorted by name', async () => {
    expect(await listAttachments(dir)).toEqual([]);
    const attachments = path.join(dir, 'attachments');
    await mkdir(path.join(attachments, 'sub'), { recursive: true });
    await writeFile(path.join(attachments, 'b.csv'), 'x,y\n');
    await writeFile(path.join(attachments, 'B.svg'), '<svg/>');
    await writeFile(path.join(attachments, 'a.png'), 'png');
    await writeFile(path.join(attachments, '.hidden'), 'x');
    await writeFile(path.join(attachments, '.part-123'), 'x');
    expect(await listAttachments(dir)).toEqual([
      { name: 'B.svg', size: 6, contentType: 'image/svg+xml', kind: 'svg' },
      { name: 'a.png', size: 3, contentType: 'image/png', kind: 'image' },
      { name: 'b.csv', size: 4, contentType: 'text/csv; charset=utf-8', kind: 'table' },
    ]);
  });

  it('resolves attachment paths and rejects unsafe names and ids', () => {
    expect(attachmentPath(dir, 'a/b', 'x.svg')).toBe(
      path.join(dir, 'a', 'b', 'attachments', 'x.svg'),
    );
    expect(() => attachmentPath(dir, 'a', '../node.md')).toThrow(/Invalid attachment name/);
    expect(() => attachmentPath(dir, 'a', '.hidden')).toThrow(/Invalid attachment name/);
    expect(() => attachmentPath(dir, 'a', 'a..b')).toThrow(/Invalid attachment name/);
    expect(() => attachmentPath(dir, 'a/attachments', 'x.svg')).toThrow(/Invalid node id/);
  });

  it('treats `attachments` as reserved at every level', () => {
    expect(() => nodeIdSegments('attachments')).toThrow(/Invalid node id/);
    expect(() => nodeIdSegments('a/attachments/b')).toThrow(/Invalid node id/);
    expect(nodeIdSegments('a/attachments-2')).toEqual(['a', 'attachments-2']);
  });
});

describe('answer staging', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let events: AttachmentEvent[];
  let controller: AbortController;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
    events = [];
    controller = new AbortController();
  });
  afterEach(() => cleanup());

  const make = () =>
    createAnswerStaging({
      parentDir: dir,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

  it('creates a hidden staging folder in the parent', async () => {
    const staging = await make();
    expect(path.dirname(staging.dir)).toBe(dir);
    expect(path.basename(staging.dir)).toMatch(/^\.tmp-answer-/);
  });

  it('saves bytes and emits saving → ready with origin', async () => {
    const staging = await make();
    const info = await staging.saveFromBytes({
      name: 'My Chart.svg',
      data: bytes('<svg/>'),
      origin: 'inline',
    });
    expect(info).toEqual({
      name: 'My-Chart.svg',
      size: 6,
      contentType: 'image/svg+xml',
      kind: 'svg',
      origin: 'inline',
    });
    expect(await readFile(path.join(staging.dir, 'attachments', 'My-Chart.svg'), 'utf8')).toBe(
      '<svg/>',
    );
    expect(events).toEqual([
      {
        status: 'saving',
        key: expect.any(String),
        requestedName: 'My Chart.svg',
        origin: 'inline',
      },
      { status: 'ready', key: events[0]?.key, attachment: info },
    ]);
    expect(await staging.list()).toEqual([
      { name: 'My-Chart.svg', size: 6, contentType: 'image/svg+xml', kind: 'svg' },
    ]);
  });

  it('empty data → failed event and AttachmentError', async () => {
    const staging = await make();
    await expect(
      staging.saveFromBytes({ name: 'a.txt', data: new Uint8Array(), origin: 'inline' }),
    ).rejects.toThrow(AttachmentError);
    expect(events.map((e) => e.status)).toEqual(['saving', 'failed']);
    expect(events[1]).toMatchObject({ message: 'Empty content', requestedName: 'a.txt' });
    expect(events[1]?.key).toBe(events[0]?.key);
  });

  it('parallel saves with the same name get distinct names', async () => {
    const staging = await make();
    const saves = await Promise.all(
      [1, 2, 3].map((n) =>
        staging.saveFromBytes({
          name: 'chart.svg',
          data: bytes(`<svg>${n}</svg>`),
          origin: 'inline',
        }),
      ),
    );
    expect(saves.map((s) => s.name).sort()).toEqual(['chart-2.svg', 'chart-3.svg', 'chart.svg']);
  });

  it('releases the name of a failed save', async () => {
    const staging = await make();
    const broken = new Readable({
      read() {
        this.destroy(new Error('stream broke'));
      },
    });
    await expect(
      staging.saveFromStream({ name: 'data.csv', stream: broken, origin: 'sandbox' }),
    ).rejects.toThrow('stream broke');
    expect(await readdir(path.join(staging.dir, 'attachments'))).toEqual([]);
    const info = await staging.saveFromStream({
      name: 'data.csv',
      stream: Readable.from(['a,b\n']),
      origin: 'sandbox',
    });
    expect(info.name).toBe('data.csv');
    expect(info.origin).toBe('sandbox');
  });

  it('discard removes the folder, is idempotent and blocks new saves', async () => {
    const staging = await make();
    await staging.saveFromBytes({ name: 'a.txt', data: bytes('a'), origin: 'inline' });
    await staging.discard();
    await staging.discard();
    await expect(stat(staging.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      staging.saveFromBytes({ name: 'b.txt', data: bytes('b'), origin: 'inline' }),
    ).rejects.toThrow(AttachmentError);
    await expect(stat(staging.dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects saves after abort', async () => {
    const staging = await make();
    controller.abort();
    await expect(
      staging.saveFromBytes({ name: 'a.txt', data: bytes('a'), origin: 'inline' }),
    ).rejects.toThrow('Aborted');
    expect(events.map((e) => e.status)).toEqual(['saving', 'failed']);
  });

  it('seal drops an empty attachments folder and blocks new saves', async () => {
    const staging = await make();
    await staging
      .saveFromBytes({ name: 'a.txt', data: new Uint8Array(), origin: 'inline' })
      .catch(() => undefined);
    await staging.seal();
    expect(await readdir(staging.dir)).toEqual([]);
    await expect(
      staging.saveFromBytes({ name: 'b.txt', data: bytes('b'), origin: 'inline' }),
    ).rejects.toThrow(/no longer accepting/);
  });

  it('uses the downloader and derives a missing extension from Content-Type', async () => {
    const staging = await createAnswerStaging({
      parentDir: dir,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      download: async ({ target }) => {
        await writeFile(target, 'png-bytes');
        return { suggestedName: 'image', contentType: 'image/png', size: 9 };
      },
    });
    const info = await staging.saveFromUrl({ url: 'https://example.com/image' });
    expect(info).toMatchObject({ name: 'image.png', kind: 'image', origin: 'url' });
    const named = await staging.saveFromUrl({ url: 'https://example.com/x', name: 'photo' });
    expect(named.name).toBe('photo.png');
    expect(events[0]).toMatchObject({ status: 'saving', origin: 'url' });
    expect(events[0]).not.toHaveProperty('requestedName', expect.anything());
  });

  it('sweeps only stale staging folders', async () => {
    const stale = path.join(dir, '.tmp-answer-old');
    const fresh = path.join(dir, '.tmp-answer-new');
    await mkdir(stale);
    await mkdir(fresh);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await sweepStaleStaging(dir);
    expect((await readdir(dir)).sort()).toEqual(['.tmp-answer-new']);
  });
});

describe('nodes with attachments', () => {
  let treeDir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir: treeDir, cleanup } = await makeTempDir());
  });
  afterEach(() => cleanup());

  const file = (user: string) => ({
    created: '2026-09-24T10:00:00.000Z',
    model: 'm',
    user,
    assistant: `A ${user}`,
  });

  it('commits a staging folder as the node folder', async () => {
    const staging = await createAnswerStaging({
      parentDir: treeDir,
      signal: new AbortController().signal,
    });
    await staging.saveFromBytes({ name: 'a.csv', data: bytes('x\n'), origin: 'inline' });
    await staging.seal();
    const id = await createNode(treeDir, '', 'topic', file('Q'), { stagingDir: staging.dir });
    expect(id).toBe('topic');
    expect((await readdir(treeDir)).sort()).toEqual(['topic']);
    expect((await readdir(path.join(treeDir, 'topic'))).sort()).toEqual(['attachments', 'node.md']);
    const [node] = await readChain(treeDir, 'topic');
    expect(node?.attachments).toEqual([
      { name: 'a.csv', size: 2, contentType: 'text/csv; charset=utf-8', kind: 'table' },
    ]);
  });

  it('never names a node `attachments` and never reads that folder as a node', async () => {
    expect(await createNode(treeDir, '', 'attachments', file('root'))).toBe('attachments-2');
    const parent = await createNode(treeDir, '', 'parent', file('p'));
    expect(await createNode(treeDir, parent, 'Attachments', file('c'))).toBe(
      'parent/attachments-2',
    );
    // A stray `attachments/node.md` must not show up as a node.
    await mkdir(path.join(treeDir, 'parent', 'attachments'), { recursive: true });
    await writeFile(
      path.join(treeDir, 'parent', 'attachments', 'node.md'),
      await readFile(path.join(treeDir, 'parent', 'node.md'), 'utf8'),
    );
    const hierarchy = await readHierarchy(treeDir);
    const ids = hierarchy.flatMap((n) => [n.id, ...n.children.map((c) => c.id)]).sort();
    expect(ids).toEqual(['attachments-2', 'parent', 'parent/attachments-2']);
    const [chainNode] = await readChain(treeDir, 'parent');
    expect(chainNode?.attachments).toEqual([
      expect.objectContaining({ name: 'node.md', kind: 'text' }),
    ]);
  });
});
