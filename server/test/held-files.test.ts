import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHeldFiles, HELD_DIR_PREFIX, moveDir, sweepHeldRoots } from '../src/storage/index.js';
import { makeTempDir } from './helpers.js';

describe('held files', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });
  afterEach(() => cleanup());

  async function stagingWithFiles(name: string, files: Record<string, string>) {
    const staging = path.join(dir, name);
    await mkdir(path.join(staging, 'files'), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await writeFile(path.join(staging, 'files', file), content);
    }
    return staging;
  }

  it('hold → restore → discard round trip', async () => {
    const root = path.join(dir, 'held');
    const held = createHeldFiles({ root });
    const id = randomUUID();
    const first = await stagingWithFiles('.tmp-answer-1', { 'a.txt': 'a', 'b.md': '# b' });

    await held.hold(id, first);
    expect(await readdir(first)).toEqual([]);
    expect((await readdir(path.join(root, id, 'files'))).sort()).toEqual(['a.txt', 'b.md']);

    const second = path.join(dir, '.tmp-answer-2');
    await mkdir(second);
    await held.restore(id, second);
    expect(await readFile(path.join(second, 'files', 'a.txt'), 'utf8')).toBe('a');
    expect(await readdir(root)).toEqual([]);

    await held.hold(id, second);
    await held.discard(id);
    await held.discard(id);
    expect(await readdir(root)).toEqual([]);
  });

  it('hold without files/ is a no-op; restore of a missing id throws', async () => {
    const root = path.join(dir, 'held');
    const held = createHeldFiles({ root });
    const id = randomUUID();
    const staging = path.join(dir, '.tmp-answer-x');
    await mkdir(staging);
    await held.hold(id, staging);
    expect(await readdir(root).catch(() => [])).toEqual([]);
    await expect(held.restore(id, staging)).rejects.toThrow(/No held files/);
    await expect(held.hold('../escape', staging)).rejects.toThrow(/Invalid question id/);
  });

  it('close() removes only an owned root', async () => {
    const root = path.join(dir, 'injected');
    const injected = createHeldFiles({ root });
    const id = randomUUID();
    await injected.hold(id, await stagingWithFiles('.tmp-a', { 'a.txt': 'a' }));
    await injected.close();
    expect(await readdir(root)).toEqual([id]);

    const owned = createHeldFiles();
    // Nothing held yet: no folder was created, close is a no-op.
    await owned.discard(id);
    await owned.close();
    const ownedId = randomUUID();
    const staging = await stagingWithFiles('.tmp-b', { 'b.txt': 'b' });
    await owned.hold(ownedId, staging);
    const before = (await readdir(path.dirname(dir))).filter((n) => n.startsWith(HELD_DIR_PREFIX));
    expect(before.length).toBeGreaterThan(0);
    await owned.close();
    const after = (await readdir(path.dirname(dir))).filter((n) => n.startsWith(HELD_DIR_PREFIX));
    expect(after.length).toBe(before.length - 1);
  });

  it('moveDir falls back to copy + remove across devices (EXDEV)', async () => {
    const src = await stagingWithFiles('src', { 'a.txt': 'a' });
    const exdev = async () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    };
    const dst = path.join(dir, 'deep', 'dst');
    await moveDir(path.join(src, 'files'), dst, exdev);
    expect(await readFile(path.join(dst, 'a.txt'), 'utf8')).toBe('a');
    expect(await readdir(src)).toEqual([]);
    const other = async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    await expect(moveDir(dst, path.join(dir, 'x'), other)).rejects.toThrow('denied');
  });

  it('sweepHeldRoots removes only old otago-held-* folders', async () => {
    const tmpDir = path.join(dir, 'tmp');
    const old = path.join(tmpDir, `${HELD_DIR_PREFIX}old`);
    const fresh = path.join(tmpDir, `${HELD_DIR_PREFIX}fresh`);
    const unrelated = path.join(tmpDir, 'unrelated-old');
    for (const folder of [old, fresh, unrelated]) await mkdir(folder, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const folder of [old, unrelated]) await utimes(folder, twoDaysAgo, twoDaysAgo);
    await sweepHeldRoots({ tmpDir });
    expect((await readdir(tmpDir)).sort()).toEqual([`${HELD_DIR_PREFIX}fresh`, 'unrelated-old']);
    await sweepHeldRoots({ tmpDir: path.join(dir, 'missing') });
  });
});
