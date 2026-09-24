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

/** First free name among `base`, `base-2`, `base-3`, … in `dir`. */
export async function uniqueName(
  dir: string,
  base: string,
  reserved: ReadonlySet<string> = new Set(),
): Promise<string> {
  const taken = new Set(await readdir(dir).catch(() => [] as string[]));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate) && !reserved.has(candidate)) return candidate;
  }
}

/**
 * First free file name among `name`, `stem-2.ext`, `stem-3.ext`, … (suffix before the last
 * extension; `README` → `README-2`). Synchronous, so callers can reserve names without races.
 * The result never exceeds `maxLength` characters.
 */
export function uniqueFileName(taken: ReadonlySet<string>, name: string, maxLength = 120): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
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
