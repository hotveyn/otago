/**
 * The demo's single mock backend, created when the first module imports it. State lives in
 * localStorage under `otago-demo:*` (web's own keys are `otago.*` and `otago:undo:*`).
 */
import { createDemo } from './demo';
import { seedFiles } from './seed';
import type { VfsStorage } from './vfs';

export const VFS_STORAGE_KEY = 'otago-demo:vfs:v1';

function browserStorage(): VfsStorage {
  try {
    const probe = 'otago-demo:probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
  } catch {
    // Private mode or blocked storage: the demo still works, it just forgets on reload.
    return { load: () => null, save: () => undefined };
  }
  return {
    load: () => localStorage.getItem(VFS_STORAGE_KEY),
    save: (json) => localStorage.setItem(VFS_STORAGE_KEY, json),
  };
}

export const demo = createDemo({ storage: browserStorage(), seed: seedFiles() });

/** Drop everything the demo stored (files, undo history) and reload with the seed. */
export function resetDemo(): void {
  try {
    localStorage.removeItem(VFS_STORAGE_KEY);
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('otago:undo:')) sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing stored.
  }
  location.replace(location.pathname);
}
