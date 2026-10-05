/**
 * In-memory virtual file system, persisted as one JSON value (localStorage in the browser).
 * Paths are `/`-joined, relative to the trees folder; `''` is the root. It plays the role of
 * `OTAGO_TREES_DIR`: `<tree>/tree.md`, `<tree>/sources/…`, `<tree>/<node…>/node.md`.
 *
 * Mutations happen inside `transaction()`: on success the whole state is saved, on any error
 * (including a full storage) it is rolled back, like the server's temp-dir + rename writes.
 */

export type FileEncoding = 'utf8' | 'base64';

interface FileEntry {
  kind: 'file';
  data: string;
  encoding: FileEncoding;
  size: number;
  /** Changes on every write; keys cached blob URLs. */
  version: number;
}

interface DirEntry {
  kind: 'dir';
}

type Entry = FileEntry | DirEntry;

export interface FileStat {
  size: number;
  version: number;
}

/** Where the serialized state lives. `save` may throw (quota). */
export interface VfsStorage {
  load(): string | null;
  save(json: string): void;
}

/** The storage refused the new state (e.g. localStorage quota). State was rolled back. */
export class StorageFullError extends Error {
  constructor(cause?: unknown) {
    super('Demo storage is full', { cause });
    this.name = 'StorageFullError';
  }
}

interface Persisted {
  v: 1;
  entries: Array<[string, Entry]>;
}

const parentOf = (p: string) => {
  const index = p.lastIndexOf('/');
  return index === -1 ? '' : p.slice(0, index);
};

export const joinPath = (...parts: string[]) => parts.filter(Boolean).join('/');

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class Vfs {
  private entries = new Map<string, Entry>();
  private saved = '';
  private nextVersion = 1;
  private depth = 0;

  constructor(private readonly storage: VfsStorage) {}

  /** Load the saved state. Returns false when there is none (or it is unreadable). */
  load(): boolean {
    const json = this.storage.load();
    if (!json) return false;
    try {
      this.restore(json);
      this.saved = json;
      return true;
    } catch {
      this.entries.clear();
      return false;
    }
  }

  /** Replace everything with `files` (path → text) and save. */
  reset(files: Record<string, string>): void {
    this.entries.clear();
    this.transaction(() => {
      for (const [p, text] of Object.entries(files)) this.writeText(p, text);
    });
  }

  /**
   * Run `fn`, then save. Nested calls join the outer one. Any error rolls the state back to
   * the last save; a storage failure is rethrown as `StorageFullError`.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      const result = fn();
      const json = this.serialize();
      try {
        this.storage.save(json);
      } catch (error) {
        throw new StorageFullError(error);
      }
      this.saved = json;
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    } finally {
      this.depth--;
    }
  }

  isDir(p: string): boolean {
    return p === '' || this.entries.get(p)?.kind === 'dir';
  }

  isFile(p: string): boolean {
    return this.entries.get(p)?.kind === 'file';
  }

  exists(p: string): boolean {
    return p === '' || this.entries.has(p);
  }

  /** Names of the direct children of `dir` (`[]` when it does not exist). */
  list(dir: string): string[] {
    if (!this.isDir(dir)) return [];
    const prefix = dir === '' ? '' : `${dir}/`;
    const names: string[] = [];
    for (const p of this.entries.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest && !rest.includes('/')) names.push(rest);
    }
    return names;
  }

  /** Direct children of `dir` that are directories. */
  listDirs(dir: string): string[] {
    return this.list(dir).filter((name) => this.isDir(joinPath(dir, name)));
  }

  /** Direct children of `dir` that are files. */
  listFiles(dir: string): string[] {
    return this.list(dir).filter((name) => this.isFile(joinPath(dir, name)));
  }

  stat(p: string): FileStat | null {
    const entry = this.entries.get(p);
    return entry?.kind === 'file' ? { size: entry.size, version: entry.version } : null;
  }

  readText(p: string): string | null {
    const entry = this.entries.get(p);
    if (entry?.kind !== 'file') return null;
    return entry.encoding === 'utf8' ? entry.data : utf8Decoder.decode(base64ToBytes(entry.data));
  }

  readBytes(p: string): Uint8Array | null {
    const entry = this.entries.get(p);
    if (entry?.kind !== 'file') return null;
    return entry.encoding === 'utf8' ? utf8.encode(entry.data) : base64ToBytes(entry.data);
  }

  mkdir(p: string): void {
    if (p === '') return;
    const entry = this.entries.get(p);
    if (entry?.kind === 'dir') return;
    if (entry) throw new Error(`Not a directory: ${p}`);
    this.mkdir(parentOf(p));
    this.entries.set(p, { kind: 'dir' });
  }

  writeText(p: string, text: string): void {
    this.write(p, { data: text, encoding: 'utf8', size: utf8.encode(text).length });
  }

  writeBytes(p: string, bytes: Uint8Array): void {
    this.write(p, { data: bytesToBase64(bytes), encoding: 'base64', size: bytes.length });
  }

  /** Move `from` (file or directory with everything inside) to `to`, which must not exist. */
  rename(from: string, to: string): void {
    if (!this.entries.has(from)) throw new Error(`Not found: ${from}`);
    if (this.exists(to)) throw new Error(`Already exists: ${to}`);
    if (to.startsWith(`${from}/`)) throw new Error(`Cannot move ${from} into itself`);
    this.mkdir(parentOf(to));
    const moved: Array<[string, Entry]> = [];
    for (const [p, entry] of this.entries) {
      if (p === from || p.startsWith(`${from}/`)) moved.push([p, entry]);
    }
    for (const [p] of moved) this.entries.delete(p);
    for (const [p, entry] of moved) this.entries.set(to + p.slice(from.length), entry);
  }

  /** Delete `p` with everything inside (no-op when missing). */
  remove(p: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key === p || key.startsWith(`${p}/`)) this.entries.delete(key);
    }
  }

  private write(p: string, file: Omit<FileEntry, 'kind' | 'version'>): void {
    if (this.entries.get(p)?.kind === 'dir') throw new Error(`Is a directory: ${p}`);
    this.mkdir(parentOf(p));
    this.entries.set(p, { kind: 'file', ...file, version: this.nextVersion++ });
  }

  private serialize(): string {
    const persisted: Persisted = { v: 1, entries: [...this.entries] };
    return JSON.stringify(persisted);
  }

  private restore(json: string): void {
    const persisted = JSON.parse(json) as Persisted;
    if (persisted.v !== 1 || !Array.isArray(persisted.entries)) throw new Error('Bad VFS state');
    this.entries = new Map(persisted.entries);
    for (const entry of this.entries.values()) {
      if (entry.kind === 'file') this.nextVersion = Math.max(this.nextVersion, entry.version + 1);
    }
  }

  private rollback(): void {
    if (this.saved) this.restore(this.saved);
    else this.entries.clear();
  }
}
