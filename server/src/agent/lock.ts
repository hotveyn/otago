import { ConflictError } from '../errors.js';

/** One running request per tree. */
export class TreeLocks {
  private readonly held = new Set<string>();

  isLocked(treeId: string): boolean {
    return this.held.has(treeId);
  }

  /** Take the lock or throw 409. Returns an idempotent release function. */
  acquire(treeId: string): () => void {
    if (this.held.has(treeId)) {
      throw new ConflictError(`Tree "${treeId}" is busy with another request`);
    }
    this.held.add(treeId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(treeId);
    };
  }

  async withLock<T>(treeId: string, fn: () => Promise<T>): Promise<T> {
    const release = this.acquire(treeId);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
