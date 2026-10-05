import { type ConflictCode, TreeBusyError } from '../errors.js';

/** Exact 409 messages; `<tree>` is replaced by the tree id. Mirrors the side-chat contract. */
const CONFLICT_MESSAGES: Record<ConflictCode, string> = {
  tree_busy_streaming:
    'Tree "<tree>" is busy: an answer is still streaming. Try again when it finishes.',
  tree_busy_structural:
    'Tree "<tree>" is busy: nodes are being moved, renamed or deleted. Try again in a moment.',
};

export interface TreeLockStatus {
  shared: number;
  exclusive: boolean;
}

interface TreeLockState extends TreeLockStatus {
  /** Shared holders (multiset): holder id → number of acquisitions. */
  holders: Map<string, number>;
}

function conflict(treeId: string, code: ConflictCode, holders: string[] = []): TreeBusyError {
  return new TreeBusyError(
    CONFLICT_MESSAGES[code].replace('<tree>', treeId),
    code,
    treeId,
    holders,
  );
}

/**
 * Per-tree readers–writer lock, in memory, per process.
 *
 * - Shared: questions being answered (and start/retry requests preparing them). Any number may
 *   run at once in one tree. Each acquisition carries a holder id (the question id), so a
 *   structural 409 can list its blockers.
 * - Exclusive: structural ops (move/delete/restore/rename). Only when nothing else is held.
 *
 * Conflicts are rejected with 409 (never queued). Acquisition is synchronous, so the check
 * and the update happen in one tick. The policy lives in `acquire*`, which is the seam for a
 * future cap on shared holders or a queueing policy.
 */
export class TreeLocks {
  private readonly state = new Map<string, TreeLockState>();
  private anonymous = 0;

  status(treeId: string): TreeLockStatus {
    const entry = this.state.get(treeId);
    return { shared: entry?.shared ?? 0, exclusive: entry?.exclusive ?? false };
  }

  /** True if any holder (shared or exclusive) exists. */
  isLocked(treeId: string): boolean {
    const { shared, exclusive } = this.status(treeId);
    return exclusive || shared > 0;
  }

  /** Ids of the current shared holders (anonymous acquisitions get unique `anon:<n>` ids). */
  holders(treeId: string): string[] {
    return [...(this.state.get(treeId)?.holders.keys() ?? [])];
  }

  /**
   * Take a shared lock for `holder` (default: a unique anonymous id) or throw 409
   * `tree_busy_structural`. Returns an idempotent release.
   */
  acquireShared(treeId: string, holder?: string): () => void {
    const entry = this.entry(treeId);
    if (entry.exclusive) {
      this.cleanup(treeId);
      throw conflict(treeId, 'tree_busy_structural');
    }
    const id = holder ?? `anon:${++this.anonymous}`;
    entry.shared++;
    entry.holders.set(id, (entry.holders.get(id) ?? 0) + 1);
    return this.releaser(treeId, (current) => {
      current.shared--;
      const count = (current.holders.get(id) ?? 0) - 1;
      if (count > 0) current.holders.set(id, count);
      else current.holders.delete(id);
    });
  }

  /** Take the exclusive lock or throw 409. Returns an idempotent release. */
  acquireExclusive(treeId: string): () => void {
    const entry = this.entry(treeId);
    if (entry.exclusive) throw conflict(treeId, 'tree_busy_structural');
    if (entry.shared > 0) throw conflict(treeId, 'tree_busy_streaming', this.holders(treeId));
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

  private entry(treeId: string): TreeLockState {
    let entry = this.state.get(treeId);
    if (!entry) {
      entry = { shared: 0, exclusive: false, holders: new Map() };
      this.state.set(treeId, entry);
    }
    return entry;
  }

  private cleanup(treeId: string): void {
    const entry = this.state.get(treeId);
    if (entry && entry.shared === 0 && !entry.exclusive) this.state.delete(treeId);
  }

  private releaser(treeId: string, undo: (entry: TreeLockState) => void): () => void {
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
