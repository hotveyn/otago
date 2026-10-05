import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const fs = await import('node:fs/promises');
const { createNode, createTree, renameNode } = await import('../src/storage/index.js');

const node = { created: '2026-09-23T10:00:00Z', model: 'm', user: 'Q', assistant: 'A' };

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('name retry after EEXIST/ENOTEMPTY', () => {
  let treesDir: string;
  let treeDir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir: treesDir, cleanup } = await makeTempDir());
    treeDir = path.join(treesDir, (await createTree(treesDir, { title: 'Rust' })).id);
  });
  afterEach(async () => {
    vi.mocked(fs.rename).mockReset();
    await cleanup();
  });

  it('createNode advances to the next suffix instead of retrying the same name', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const targets: string[] = [];
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      targets.push(path.basename(String(to)));
      // A fold twin of `topic` the directory listing cannot see (another writer, another FS).
      if (path.basename(String(to)) === 'topic') throw errno('ENOTEMPTY');
      return actual.rename(from, to);
    });
    const id = await createNode(treeDir, '', 'topic', node);
    expect(id).toBe('topic-2');
    expect(targets).toEqual(['topic', 'topic-2']);
    expect((await readdir(treeDir)).sort()).toEqual(['topic-2', 'tree.md']);
  });

  it('renameNode advances too', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await createNode(treeDir, '', 'a', node);
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === 'straße') throw errno('EEXIST');
      return actual.rename(from, to);
    });
    expect((await renameNode(treeDir, 'a', 'Straße')).id).toBe('straße-2');
  });
});
