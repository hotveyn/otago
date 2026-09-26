import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimUniqueName } from '../src/storage/fs-utils.js';
import {
  createAnswerStaging,
  createNode,
  createTree,
  createUserFileStager,
  type NodeFile,
  nodeDirOf,
  nodeIdSegments,
  parseNodeFile,
  parseTreeFile,
  readChain,
  readHierarchy,
  serializeNodeFile,
  serializeTreeFile,
  toKebabCase,
  treeDirOf,
} from '../src/storage/index.js';
import { makeTempDir } from './helpers.js';

const node = (created: string, user = 'Q', assistant = 'A'): NodeFile => ({
  created,
  model: 'claude-opus-5-5',
  user,
  assistant,
});

describe('format', () => {
  it('round-trips tree.md', () => {
    const tree = {
      title: 'Rust basics: part #1',
      created: '2026-09-23T10:00:00.000Z',
      instructions: 'Answer in Russian.\n\nCompare with C++.',
    };
    expect(parseTreeFile(serializeTreeFile(tree))).toEqual(tree);
  });

  it('round-trips tree.md with empty instructions', () => {
    const tree = { title: 'Go', created: '2026-09-23T10:00:00.000Z', instructions: '' };
    expect(parseTreeFile(serializeTreeFile(tree))).toEqual(tree);
  });

  it('parses the design doc example', () => {
    const text = `---
created: 2026-09-23T10:00:00Z
model: claude-opus-5-5
---
<!-- otago:user -->
What is borrowing?

<!-- otago:assistant -->
Borrowing lets you reference a value without taking ownership [^1].

[^1]: sources/the-book-ch4.md:120-134
`;
    expect(parseNodeFile(text)).toEqual({
      created: '2026-09-23T10:00:00.000Z',
      model: 'claude-opus-5-5',
      user: 'What is borrowing?',
      assistant:
        'Borrowing lets you reference a value without taking ownership [^1].\n\n[^1]: sources/the-book-ch4.md:120-134',
    });
  });

  it('round-trips node.md with markdown content', () => {
    const value = node(
      '2026-09-23T10:00:00.000Z',
      'Line 1\n\n```rust\nlet x = 5;\n```',
      '# Title\n\n- a\n- b\n\n---\n\nText',
    );
    const text = serializeNodeFile(value);
    expect(text).toContain('<!-- otago:user -->');
    expect(text).toContain('<!-- otago:assistant -->');
    expect(parseNodeFile(text)).toEqual(value);
  });

  it('rejects node.md without markers', () => {
    expect(() => parseNodeFile('---\ncreated: 2026-01-01T00:00:00Z\n---\nhello')).toThrow();
  });
});

describe('tree hierarchy', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let treeDir: string;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
    const tree = await createTree(dir, { title: 'Rust basics', instructions: 'Be brief.' });
    treeDir = path.join(dir, tree.id);
  });
  afterEach(() => cleanup());

  it('creates a tree folder with a kebab-case id', async () => {
    expect(await readdir(dir)).toEqual(['rust-basics']);
    const second = await createTree(dir, { title: 'Rust Basics!' });
    expect(second.id).toBe('rust-basics-2');
  });

  it('reads nested nodes sorted by created, skipping sources and non-nodes', async () => {
    await createNode(treeDir, '', 'lifetimes', node('2026-09-23T12:00:00Z'));
    await createNode(treeDir, '', 'ownership', node('2026-09-23T10:00:00Z'));
    await createNode(treeDir, 'ownership', 'move semantics', node('2026-09-23T11:30:00Z'));
    await createNode(treeDir, 'ownership', 'Borrowing Rules', node('2026-09-23T11:00:00Z'));
    await mkdir(path.join(treeDir, 'sources'), { recursive: true });
    await writeFile(path.join(treeDir, 'sources', 'book.md'), '# Book');
    await mkdir(path.join(treeDir, 'not-a-node'));

    const hierarchy = await readHierarchy(treeDir);
    expect(hierarchy.map((n) => n.id)).toEqual(['ownership', 'lifetimes']);
    expect(hierarchy[0]?.children.map((n) => n.id)).toEqual([
      'ownership/borrowing-rules',
      'ownership/move-semantics',
    ]);
    expect(hierarchy[1]?.children).toEqual([]);
  });

  it('reads the chain root → node', async () => {
    await createNode(treeDir, '', 'ownership', node('2026-09-23T10:00:00Z', 'Q1', 'A1'));
    await createNode(treeDir, 'ownership', 'borrowing', node('2026-09-23T11:00:00Z', 'Q2', 'A2'));
    const chain = await readChain(treeDir, 'ownership/borrowing');
    expect(chain.map((n) => [n.id, n.name, n.user, n.assistant])).toEqual([
      ['ownership', 'ownership', 'Q1', 'A1'],
      ['ownership/borrowing', 'borrowing', 'Q2', 'A2'],
    ]);
    expect(await readChain(treeDir, '')).toEqual([]);
    await expect(readChain(treeDir, 'ownership/missing')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('adds a -N suffix on name collision and avoids reserved names at root', async () => {
    const a = await createNode(treeDir, '', 'ownership', node('2026-09-23T10:00:00Z'));
    const b = await createNode(treeDir, '', 'ownership', node('2026-09-23T10:01:00Z'));
    const c = await createNode(treeDir, '', 'Ownership', node('2026-09-23T10:02:00Z'));
    const s = await createNode(treeDir, '', 'sources', node('2026-09-23T10:03:00Z'));
    expect([a, b, c, s]).toEqual(['ownership', 'ownership-2', 'ownership-3', 'sources-2']);
    const nested = await createNode(treeDir, 'ownership', 'sources', node('2026-09-23T10:04:00Z'));
    expect(nested).toBe('ownership/sources');
  });

  it('reserves the files folder name at every level', async () => {
    await createNode(treeDir, '', 'ownership', node('2026-09-23T10:00:00Z'));
    expect(await createNode(treeDir, '', 'files', node('2026-09-23T10:01:00Z'))).toBe('files-2');
    expect(await createNode(treeDir, 'ownership', 'files', node('2026-09-23T10:02:00Z'))).toBe(
      'ownership/files-2',
    );
    for (const bad of ['files', 'ownership/files', 'files/x']) {
      expect(() => nodeIdSegments(bad), bad).toThrow('Invalid node id');
    }
  });

  it('skips a files folder with a node.md in the hierarchy', async () => {
    await createNode(treeDir, '', 'ownership', node('2026-09-23T10:00:00Z'));
    for (const dirName of [path.join(treeDir, 'files'), path.join(treeDir, 'ownership', 'files')]) {
      await mkdir(dirName);
      await writeFile(
        path.join(dirName, 'node.md'),
        serializeNodeFile(node('2026-09-23T10:00:00Z')),
      );
    }
    const hierarchy = await readHierarchy(treeDir);
    expect(hierarchy.map((n) => n.id)).toEqual(['ownership']);
    expect(hierarchy[0]?.children).toEqual([]);
  });

  it('lists user files in the chain ([] for nodes without them)', async () => {
    await createNode(treeDir, '', 'ownership', node('2026-09-23T10:00:00Z'));
    await createNode(treeDir, 'ownership', 'borrowing', node('2026-09-23T11:00:00Z'));
    const files = path.join(treeDir, 'ownership', 'borrowing', 'files');
    await mkdir(files);
    await writeFile(path.join(files, 'notes.md'), '# n');
    const chain = await readChain(treeDir, 'ownership/borrowing');
    expect(chain.map((n) => n.files)).toEqual([
      [],
      [{ name: 'notes.md', size: 3, contentType: 'text/markdown; charset=utf-8', kind: 'text' }],
    ]);
  });

  it('commits staged user files with the node; seal keeps files/', async () => {
    const staging = await createAnswerStaging({
      parentDir: treeDir,
      signal: new AbortController().signal,
    });
    const stager = createUserFileStager({
      stagingDir: staging.dir,
      signal: new AbortController().signal,
    });
    await stager.addFromStream({
      filename: 'a.txt',
      mimetype: 'text/plain',
      stream: Readable.from([Buffer.from('hello')]),
    });
    await staging.seal();
    const id = await createNode(treeDir, '', 'topic', node('2026-09-23T10:00:00Z'), {
      stagingDir: staging.dir,
    });
    staging.release();
    expect((await readdir(path.join(treeDir, id))).sort()).toEqual(['files', 'node.md']);
    const [chainNode] = await readChain(treeDir, id);
    expect(chainNode?.files.map((f) => f.name)).toEqual(['a.txt']);
    expect(chainNode?.attachments).toEqual([]);
  });

  it('writes node.md atomically without leaving temp folders', async () => {
    const id = await createNode(treeDir, '', 'x', node('2026-09-23T10:00:00Z', 'Q', 'A'));
    const entries = await readdir(treeDir);
    expect(entries.sort()).toEqual(['tree.md', 'x']);
    const text = await readFile(path.join(treeDir, id, 'node.md'), 'utf8');
    expect(parseNodeFile(text).user).toBe('Q');
  });

  it('gives concurrent creations under one parent distinct names, never overwriting', async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        createNode(treeDir, '', 'ownership', node('2026-09-23T10:00:00Z', `Q${n}`, `A${n}`)),
      ),
    );
    expect([...ids].sort()).toEqual([
      'ownership',
      'ownership-2',
      'ownership-3',
      'ownership-4',
      'ownership-5',
    ]);
    for (const [index, id] of ids.entries()) {
      const file = parseNodeFile(await readFile(path.join(treeDir, id, 'node.md'), 'utf8'));
      expect(file).toMatchObject({ user: `Q${index + 1}`, assistant: `A${index + 1}` });
    }
    expect((await readdir(treeDir)).sort()).toEqual([...ids.sort(), 'tree.md']);
  });

  it('commits concurrent staging folders under one parent into distinct nodes', async () => {
    const stagings = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const staging = await createAnswerStaging({
          parentDir: treeDir,
          signal: new AbortController().signal,
        });
        await staging.saveFromBytes({
          name: `file-${n}.txt`,
          data: new Uint8Array(Buffer.from(`content ${n}`)),
          origin: 'inline',
        });
        await staging.seal();
        return staging;
      }),
    );
    const ids = await Promise.all(
      stagings.map((staging, index) =>
        createNode(treeDir, '', 'topic', node('2026-09-23T10:00:00Z', `Q${index + 1}`), {
          stagingDir: staging.dir,
        }),
      ),
    );
    for (const staging of stagings) staging.release();
    expect([...ids].sort()).toEqual(['topic', 'topic-2', 'topic-3']);
    for (const [index, id] of ids.entries()) {
      const [chainNode] = await readChain(treeDir, id);
      expect(chainNode?.user).toBe(`Q${index + 1}`);
      expect(chainNode?.attachments.map((a) => a.name)).toEqual([`file-${index + 1}.txt`]);
    }
    expect((await readdir(treeDir)).sort()).toEqual(['topic', 'topic-2', 'topic-3', 'tree.md']);
  });

  it('rejects creating under a missing parent', async () => {
    await expect(
      createNode(treeDir, 'nope', 'x', node('2026-09-23T10:00:00Z')),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('claimUniqueName', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });
  afterEach(() => cleanup());

  it('hands out distinct names until released', async () => {
    await mkdir(path.join(dir, 'x'));
    const [a, b] = await Promise.all([claimUniqueName(dir, 'x'), claimUniqueName(dir, 'x')]);
    expect([a.name, b.name].sort()).toEqual(['x-2', 'x-3']);
    const reserved = await claimUniqueName(dir, 'x', new Set(['x-4']));
    expect(reserved.name).toBe('x-5');
    a.release();
    a.release();
    const again = await claimUniqueName(dir, 'x');
    expect(again.name).toBe(a.name);
    for (const claim of [b, reserved, again]) claim.release();
    expect((await claimUniqueName(dir, 'x')).name).toBe('x-2');
  });

  it('treats a missing dir as empty', async () => {
    const claim = await claimUniqueName(path.join(dir, 'missing'), 'y');
    expect(claim.name).toBe('y');
    claim.release();
  });
});

describe('path safety', () => {
  it('rejects node ids escaping the tree folder', () => {
    const treeDir = '/trees/rust';
    for (const bad of [
      '..',
      '../other',
      'a/../../x',
      '/etc/passwd',
      'a//b',
      'a/./b',
      'a\\b',
      'sources',
      'tree.md',
    ]) {
      expect(() => nodeDirOf(treeDir, bad), bad).toThrow();
    }
    expect(nodeDirOf(treeDir, 'a/b')).toBe(path.resolve('/trees/rust/a/b'));
    expect(nodeDirOf(treeDir, '')).toBe(path.resolve('/trees/rust'));
  });

  it('rejects unsafe tree ids', () => {
    for (const bad of ['..', '../x', '/abs', 'a/b', '', 'UPPER']) {
      expect(() => treeDirOf('/trees', bad), bad).toThrow();
    }
  });

  it('kebab-cases names', () => {
    expect(toKebabCase('  Hello, World!  ')).toBe('hello-world');
    expect(toKebabCase('Café crème')).toBe('cafe-creme');
    expect(toKebabCase('Привет')).toBe('node');
    expect(toKebabCase('../../etc')).toBe('etc');
  });
});
