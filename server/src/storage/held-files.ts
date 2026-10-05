// Mirrors .claude/features/parallel-questions/contracts/lifecycle.ts ("Files of failed questions")
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists, isErrno } from './fs-utils.js';
import { resolveInside, USER_FILES_DIR } from './paths.js';

/** Prefix of the per-process holding folder in the OS temp dir. */
export const HELD_DIR_PREFIX = 'otago-held-';
/** Startup sweep: holding folders older than this are orphans of a crashed process. */
export const HELD_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Move a folder. `rename` first; across devices (`EXDEV`, e.g. a tmpfs `/tmp`) copy + remove.
 * `renameImpl` is injectable for the EXDEV test.
 */
export async function moveDir(
  src: string,
  dst: string,
  renameImpl: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  await mkdir(path.dirname(dst), { recursive: true });
  try {
    await renameImpl(src, dst);
  } catch (error) {
    if (!isErrno(error, 'EXDEV')) throw error;
    await cp(src, dst, { recursive: true, errorOnExist: true, force: false });
    await rm(src, { recursive: true, force: true });
  }
}

/**
 * User files of failed questions, kept OUTSIDE `trees/` until the question is retried or
 * removed: `<root>/<questionId>/files`.
 */
export interface HeldFiles {
  /** Move `<stagingDir>/files` into the holding folder. No `files/` → no-op. */
  hold(id: string, stagingDir: string): Promise<void>;
  /** Move the held files back into `<stagingDir>/files`. Throws if nothing is held. */
  restore(id: string, stagingDir: string): Promise<void>;
  /** Remove the held files of `id`. Idempotent. */
  discard(id: string): Promise<void>;
  /** Remove the holding root if this instance created it. */
  close(): Promise<void>;
}

export interface HeldFilesOptions {
  /** Holding root (tests). Default: `mkdtemp(<os.tmpdir()>/otago-held-)`, created lazily, owned. */
  root?: string;
}

export function createHeldFiles(options: HeldFilesOptions = {}): HeldFiles {
  const owned = options.root === undefined;
  let rootPromise: Promise<string> | undefined;

  const root = (): Promise<string> => {
    rootPromise ??= options.root
      ? mkdir(options.root, { recursive: true }).then(() => options.root as string)
      : mkdtemp(path.join(os.tmpdir(), HELD_DIR_PREFIX));
    return rootPromise;
  };

  const assertId = (id: string) => {
    if (!UUID_RE.test(id)) throw new Error(`Invalid question id: ${id}`);
  };
  const folderOf = (base: string, id: string) => {
    assertId(id);
    return resolveInside(base, id);
  };

  return {
    async hold(id, stagingDir) {
      assertId(id);
      const src = path.join(stagingDir, USER_FILES_DIR);
      if (!(await exists(src))) return;
      const folder = folderOf(await root(), id);
      await rm(folder, { recursive: true, force: true });
      await moveDir(src, path.join(folder, USER_FILES_DIR));
    },

    async restore(id, stagingDir) {
      const folder = folderOf(await root(), id);
      const src = path.join(folder, USER_FILES_DIR);
      if (!(await exists(src))) throw new Error(`No held files for question ${id}`);
      await moveDir(src, path.join(stagingDir, USER_FILES_DIR));
      await rm(folder, { recursive: true, force: true });
    },

    async discard(id) {
      assertId(id);
      // Nothing was ever held by an owned root that does not exist yet.
      if (owned && !rootPromise) return;
      await rm(folderOf(await root(), id), { recursive: true, force: true });
    },

    async close() {
      if (!owned || !rootPromise) return;
      const dir = await rootPromise.catch(() => undefined);
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Best effort: remove `otago-held-*` folders in `tmpDir` older than `maxAgeMs` (orphans of a
 * crashed process). Called once by the production entry point.
 */
export async function sweepHeldRoots(
  options: { tmpDir?: string; maxAgeMs?: number } = {},
): Promise<void> {
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const cutoff = Date.now() - (options.maxAgeMs ?? HELD_SWEEP_AGE_MS);
  const entries = await readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(HELD_DIR_PREFIX)) continue;
    const target = path.join(tmpDir, entry.name);
    try {
      if ((await stat(target)).mtimeMs < cutoff) await rm(target, { recursive: true, force: true });
    } catch {
      // Ignore: another process may have removed it.
    }
  }
}
