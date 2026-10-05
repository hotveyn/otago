import { createDemo, type DemoOptions } from './demo';
import type { VfsStorage } from './vfs';

/** In-memory storage; `failNextSave` simulates a full localStorage. */
export function memoryStorage(initial: string | null = null) {
  let value = initial;
  let fail = false;
  const storage: VfsStorage & { value: () => string | null; failNextSave: () => void } = {
    load: () => value,
    save: (json) => {
      if (fail) {
        fail = false;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      value = json;
    },
    value: () => value,
    failNextSave: () => {
      fail = true;
    },
  };
  return storage;
}

export const NODE = (user: string, created: string) =>
  `---\ncreated: ${created}\nmodel: claude-opus-5-5\n---\n<!-- otago:user -->\n${user}\n\n<!-- otago:assistant -->\nAnswer to ${user}\n`;

/** A small tree: `a` (with `a/b`) and `c`. */
export const SMALL_SEED: Record<string, string> = {
  't/tree.md': '---\ntitle: T\ncreated: 2026-01-01T00:00:00.000Z\n---\nBe brief.\n',
  't/a/node.md': NODE('A?', '2026-01-01T00:01:00.000Z'),
  't/a/b/node.md': NODE('B?', '2026-01-01T00:02:00.000Z'),
  't/c/node.md': NODE('C?', '2026-01-01T00:03:00.000Z'),
  't/sources/notes.md': '# Notes\n',
};

let counter = 0;

export function makeDemo(options: Partial<DemoOptions> = {}) {
  const storage = memoryStorage();
  const demo = createDemo({
    storage,
    seed: SMALL_SEED,
    latency: () => 0,
    random: () => 0.5,
    now: () => Date.parse('2026-02-01T00:00:00.000Z') + counter++,
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    ...options,
  });
  return { demo, storage };
}
