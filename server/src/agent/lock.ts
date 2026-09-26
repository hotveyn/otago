import { type ConflictCode, ConflictError } from '../errors.js';

/** Exact 409 messages; `<tree>` is replaced by the tree id. Mirrors the side-chat contract. */
const CONFLICT_MESSAGES: Record<ConflictCode, string> = {
  tree_busy_streaming:
    'Tree "<tree>" is busy: an answer is still streaming. Try again when it finishes.',
  tree_busy_structural:
    'Tree "<tree>" is busy: nodes are being moved or deleted. Try again in a moment.',
};

export interface TreeLockStatus {
  shared: number;
  exclusive: boolean;
}

function conflict(treeId: string, code: ConflictCode): ConflictError {
  return new ConflictError(CONFLICT_MESSAGES[code].replace('<tree>', treeId), code);
}

/**
 * Per-tree readers–writer lock, in memory, per process.
 *
 * - Shared: message streams. Any number may run at once in one tree.
 * - Exclusive: structural ops (move/delete). Only when nothing else is held.
 *
 * Conflicts are rejected with 409 (never queued). Acquisition is synchronous, so the check
 * and the update happen in one tick. The policy lives in `acquire*`, which is the seam for a
 * future cap on shared holders or a queueing policy.
 */
export class TreeLocks {
  private readonly state = new Map<string, TreeLockStatus>();

  status(treeId: string): TreeLockStatus {
    const entry = this.state.get(treeId);
    return { shared: entry?.shared ?? 0, exclusive: entry?.exclusive ?? false };
  }

  /** True if any holder (shared or exclusive) exists. */
  isLocked(treeId: string): boolean {
    const { shared, exclusive } = this.status(treeId);
    return exclusive || shared > 0;
  }

  /** Take a shared lock or throw 409 `tree_busy_structural`. Returns an idempotent release. */
  acquireShared(treeId: string): () => void {
    const entry = this.entry(treeId);
    if (entry.exclusive) {
      this.cleanup(treeId);
      throw conflict(treeId, 'tree_busy_structural');
    }
    entry.shared++;
    return this.releaser(treeId, (current) => {
      current.shared--;
    });
  }

  /** Take the exclusive lock or throw 409. Returns an idempotent release. */
  acquireExclusive(treeId: string): () => void {
    const entry = this.entry(treeId);
    if (entry.exclusive) throw conflict(treeId, 'tree_busy_structural');
    if (entry.shared > 0) throw conflict(treeId, 'tree_busy_streaming');
    entry.exclusive = true;
    return this.releaser(treeId, (current) => {
      current.exclusive = false;
    });
  }

  async withShared<T>(treeId: string, fn: () => Promise<T>): Promise<T> {
    const release = this.acquireShared(treeId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async withExclusive<T>(treeId: string, fn: () => Promise<T>): Promise<T> {
    const release = this.acquireExclusive(treeId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private entry(treeId: string): TreeLockStatus {
    let entry = this.state.get(treeId);
    if (!entry) {
      entry = { shared: 0, exclusive: false };
      this.state.set(treeId, entry);
    }
    return entry;
  }

  private cleanup(treeId: string): void {
    const entry = this.state.get(treeId);
    if (entry && entry.shared === 0 && !entry.exclusive) this.state.delete(treeId);
  }

  private releaser(treeId: string, undo: (entry: TreeLockStatus) => void): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = this.state.get(treeId);
      if (entry) undo(entry);
      this.cleanup(treeId);
    };
  }
}
