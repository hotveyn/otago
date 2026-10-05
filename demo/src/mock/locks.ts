/**
 * Per-tree readers–writer lock, as `server/src/agent/lock.ts`: questions hold it shared,
 * structural changes take it exclusively, conflicts are rejected with 409 (never queued).
 */
import type { ConflictCode, TreeBusyDetails } from '../../../web/src/api/types';
import { conflict } from './errors';

const CONFLICT_MESSAGES: Record<ConflictCode, string> = {
  tree_busy_streaming:
    'Tree "<tree>" is busy: an answer is still streaming. Try again when it finishes.',
  tree_busy_structural:
    'Tree "<tree>" is busy: nodes are being moved, renamed or deleted. Try again in a moment.',
};

interface LockState {
  exclusive: boolean;
  /** Shared holder id → number of acquisitions. */
  holders: Map<string, number>;
}

/** `details` of a 409 `tree_busy_streaming` for these shared holders. */
export type BlockersOf = (treeId: string, holders: string[]) => TreeBusyDetails;

export class TreeLocks {
  private readonly state = new Map<string, LockState>();

  constructor(private readonly blockersOf: BlockersOf) {}

  /** Take a shared lock for `holder` or throw 409 `tree_busy_structural`. Idempotent release. */
  acquireShared(treeId: string, holder: string): () => void {
    const entry = this.entry(treeId);
    if (entry.exclusive) throw this.conflict(treeId, 'tree_busy_structural');
    entry.holders.set(holder, (entry.holders.get(holder) ?? 0) + 1);
    return this.releaser(treeId, (current) => {
      const count = (current.holders.get(holder) ?? 0) - 1;
      if (count > 0) current.holders.set(holder, count);
      else current.holders.delete(holder);
    });
  }

  /** Take the exclusive lock or throw 409. Idempotent release. */
  acquireExclusive(treeId: string): () => void {
    const entry = this.entry(treeId);
    if (entry.exclusive) throw this.conflict(treeId, 'tree_busy_structural');
    if (entry.holders.size > 0) throw this.conflict(treeId, 'tree_busy_streaming');
    entry.exclusive = true;
    return this.releaser(treeId, (current) => {
      current.exclusive = false;
    });
  }

  /** Run `fn` under the exclusive lock of every tree in `treeIds` (taken in order). */
  withExclusive<T>(treeIds: string[], fn: () => T): T {
    const releases: Array<() => void> = [];
    try {
      for (const treeId of treeIds) releases.push(this.acquireExclusive(treeId));
      return fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private conflict(treeId: string, code: ConflictCode) {
    const details =
      code === 'tree_busy_streaming'
        ? this.blockersOf(treeId, [...(this.state.get(treeId)?.holders.keys() ?? [])])
        : undefined;
    return conflict(CONFLICT_MESSAGES[code].replace('<tree>', treeId), code, details);
  }

  private entry(treeId: string): LockState {
    let entry = this.state.get(treeId);
    if (!entry) {
      entry = { exclusive: false, holders: new Map() };
      this.state.set(treeId, entry);
    }
    return entry;
  }

  private releaser(treeId: string, undo: (entry: LockState) => void): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = this.state.get(treeId);
      if (!entry) return;
      undo(entry);
      if (!entry.exclusive && entry.holders.size === 0) this.state.delete(treeId);
    };
  }
}
