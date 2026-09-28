import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from './helpers.js';

vi.mock('../src/storage/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage/fs-utils.js')>();
  return {
    ...actual,
    writeFileAtomic: vi.fn(actual.writeFileAtomic),
  };
});

const fsUtils = await import('../src/storage/fs-utils.js');
const { createTree, updateTree } = await import('../src/storage/index.js');

describe('tree rename rollback', () => {
  let treesDir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir: treesDir, cleanup } = await makeTempDir());
    await createTree(treesDir, { title: 'Rust', instructions: 'keep' });
  });
  afterEach(() => cleanup());

  it('renames the folder back when writing tree.md fails', async () => {
    const before = await readFile(path.join(treesDir, 'rust', 'tree.md'), 'utf8');
    vi.mocked(fsUtils.writeFileAtomic).mockRejectedValueOnce(new Error('disk full'));
    const release = vi.fn();
    const lockTarget = vi.fn(() => release);
    await expect(
      updateTree(treesDir, 'rust', { title: 'Rust Basics' }, { lockTarget }),
    ).rejects.toThrow('disk full');
    expect(lockTarget).toHaveBeenCalledWith('rust-basics');
    expect(release).toHaveBeenCalledTimes(1);
    expect(await readdir(treesDir)).toEqual(['rust']);
    expect(await readFile(path.join(treesDir, 'rust', 'tree.md'), 'utf8')).toBe(before);
  });
});
