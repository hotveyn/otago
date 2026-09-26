import { mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TEMP_PREFIX } from './paths.js';

export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

export function isErrno(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    codes.includes((error as NodeJS.ErrnoException).code ?? '')
  );
}

/** First free name among `base`, `base-2`, `base-3`, … not in any of `taken`. */
function pickName(base: string, ...taken: ReadonlySet<string>[]): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.some((set) => set.has(candidate))) return candidate;
  }
}

/** First free name among `base`, `base-2`, `base-3`, … in `dir`. */
export async function uniqueName(
  dir: string,
  base: string,
  reserved: ReadonlySet<string> = new Set(),
): Promise<string> {
  const taken = new Set(await readdir(dir).catch(() => [] as string[]));
  return pickName(base, taken, reserved);
}

/** Names handed out by `claimUniqueName` and not yet released, keyed by resolved dir. */
const claims = new Map<string, Set<string>>();

export interface NameClaim {
  name: string;
  /** Drop the claim. Idempotent. */
  release: () => void;
}

/**
 * Like `uniqueName`, but the picked name is also reserved in this process until `release()`,
 * so concurrent callers never get the same name for one dir. The pick and the claim run
 * synchronously after `readdir`, so there is no race between them.
 */
export async function claimUniqueName(
  dir: string,
  base: string,
  reserved: ReadonlySet<string> = new Set(),
): Promise<NameClaim> {
  const key = path.resolve(dir);
  const taken = new Set(await readdir(dir).catch(() => [] as string[]));
  let claimed = claims.get(key);
  if (!claimed) {
    claimed = new Set();
    claims.set(key, claimed);
  }
  const name = pickName(base, taken, reserved, claimed);
  claimed.add(name);
  let released = false;
  return {
    name,
    release: () => {
      if (released) return;
      released = true;
      const current = claims.get(key);
      if (!current) return;
      current.delete(name);
      if (current.size === 0) claims.delete(key);
    },
  };
}

/**
 * First free file name among `name`, `stem-2.ext`, `stem-3.ext`, … (suffix before the last
 * extension; `README` → `README-2`). When `extension` is given and `name` ends with it, the
 * suffix goes before that whole extension (`book.fb2.zip` → `book-2.fb2.zip`).
 * Synchronous, so callers can reserve names without races.
 * The result never exceeds `maxLength` characters.
 */
export function uniqueFileName(
  taken: ReadonlySet<string>,
  name: string,
  maxLength = 120,
  extension?: string,
): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const whole = extension && name.length > extension.length && name.endsWith(extension);
  const stem = whole ? name.slice(0, -extension.length) : dot > 0 ? name.slice(0, dot) : name;
  const ext = whole ? extension : dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const room = Math.max(1, maxLength - suffix.length - ext.length);
    const candidate = `${stem.slice(0, room)}${suffix}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Build a directory in a temp folder next to the target, then rename it into place.
 * The temp folder lives under `parentDir` so the rename never crosses devices.
 */
export async function createDirAtomic(
  parentDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(parentDir, TEMP_PREFIX));
  try {
    for (const [file, content] of Object.entries(files)) {
      await writeFile(path.join(tempDir, file), content, 'utf8');
    }
    await rename(tempDir, path.join(parentDir, name));
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** Write a file via temp file + rename so readers never see a partial file. */
export async function writeFileAtomic(target: string, content: string | Uint8Array): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `${TEMP_PREFIX}${path.basename(target)}-${process.pid}-${Date.now()}`,
  );
  try {
    await writeFile(temp, content);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
