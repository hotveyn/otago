import { describe, expect, it } from 'vitest';
import { memoryStorage } from './test-helpers';
import { StorageFullError, Vfs } from './vfs';

describe('Vfs', () => {
  it('writes, lists, renames and removes, creating parent folders', () => {
    const vfs = new Vfs(memoryStorage());
    vfs.transaction(() => {
      vfs.writeText('t/a/node.md', 'hello');
      vfs.writeBytes('t/a/files/x.bin', new Uint8Array([0, 255, 7]));
    });
    expect(vfs.isDir('t/a')).toBe(true);
    expect(vfs.list('t')).toEqual(['a']);
    expect(vfs.listFiles('t/a')).toEqual(['node.md']);
    expect(vfs.listDirs('t/a')).toEqual(['files']);
    expect([...(vfs.readBytes('t/a/files/x.bin') ?? [])]).toEqual([0, 255, 7]);
    expect(vfs.stat('t/a/node.md')?.size).toBe(5);

    vfs.transaction(() => vfs.rename('t/a', 't/b'));
    expect(vfs.exists('t/a')).toBe(false);
    expect(vfs.readText('t/b/node.md')).toBe('hello');
    expect(vfs.readText('t/b/files/x.bin')).not.toBeNull();

    vfs.transaction(() => vfs.remove('t/b'));
    expect(vfs.list('t')).toEqual([]);
  });

  it('refuses to rename onto an existing path or into itself', () => {
    const vfs = new Vfs(memoryStorage());
    vfs.transaction(() => {
      vfs.writeText('a/x', '1');
      vfs.writeText('b/x', '2');
    });
    expect(() => vfs.rename('a', 'b')).toThrow(/exists/);
    expect(() => vfs.rename('a', 'a/c')).toThrow(/itself/);
  });

  it('persists every transaction and loads it back', () => {
    const storage = memoryStorage();
    const vfs = new Vfs(storage);
    vfs.transaction(() => vfs.writeText('t/tree.md', 'x'));
    const loaded = new Vfs(memoryStorage(storage.value()));
    expect(loaded.load()).toBe(true);
    expect(loaded.readText('t/tree.md')).toBe('x');
  });

  it('rolls back a transaction that throws', () => {
    const vfs = new Vfs(memoryStorage());
    vfs.transaction(() => vfs.writeText('keep', '1'));
    expect(() =>
      vfs.transaction(() => {
        vfs.writeText('lost', '2');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(vfs.exists('lost')).toBe(false);
    expect(vfs.readText('keep')).toBe('1');
  });

  it('rolls back and reports StorageFullError when the storage refuses the state', () => {
    const storage = memoryStorage();
    const vfs = new Vfs(storage);
    vfs.transaction(() => vfs.writeText('keep', '1'));
    storage.failNextSave();
    expect(() => vfs.transaction(() => vfs.writeText('big', '2'))).toThrow(StorageFullError);
    expect(vfs.exists('big')).toBe(false);
    expect(vfs.readText('keep')).toBe('1');
  });

  it('gives every write a new version', () => {
    const vfs = new Vfs(memoryStorage());
    vfs.transaction(() => vfs.writeText('f', '1'));
    const first = vfs.stat('f')?.version;
    vfs.transaction(() => vfs.writeText('f', '2'));
    expect(vfs.stat('f')?.version).not.toBe(first);
  });

  it('ignores unreadable saved state', () => {
    expect(new Vfs(memoryStorage('{not json')).load()).toBe(false);
  });
});
