import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNode,
  createTree,
  type NodeFile,
  nodeDirOf,
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

  it('writes node.md atomically without leaving temp folders', async () => {
    const id = await createNode(treeDir, '', 'x', node('2026-09-23T10:00:00Z', 'Q', 'A'));
    const entries = await readdir(treeDir);
    expect(entries.sort()).toEqual(['tree.md', 'x']);
    const text = await readFile(path.join(treeDir, id, 'node.md'), 'utf8');
    expect(parseNodeFile(text).user).toBe('Q');
  });

  it('rejects creating under a missing parent', async () => {
    await expect(
      createNode(treeDir, 'nope', 'x', node('2026-09-23T10:00:00Z')),
    ).rejects.toMatchObject({ statusCode: 404 });
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
