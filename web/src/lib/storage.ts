/** Minimal string key–value store; `set(key, null)` removes the key. Never throws. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

function safeStore(pick: () => Storage): KeyValueStore {
  return {
    get(key) {
      try {
        return pick().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) pick().removeItem(key);
        else pick().setItem(key, value);
      } catch {
        // Ignore: the value just won't persist.
      }
    },
  };
}

/** localStorage that never throws (private mode, blocked storage). */
export const safeStorage: KeyValueStore = safeStore(() => window.localStorage);

/** sessionStorage (per tab, survives reloads) that never throws. */
export const safeSession: KeyValueStore = safeStore(() => window.sessionStorage);
