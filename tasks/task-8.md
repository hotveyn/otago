# Task 8: Two demo tabs erase each other's work

Priority: **Must fix** (data loss in the public demo). Source: repo audit, 2026-10-17.

## Now

1. Developer: re-read storage at the start of the outermost `transaction()` (`demo/src/mock/vfs.ts:110-129`). About 15 minutes.
2. Developer: add one test with two VFS instances on one storage. About 15 minutes.

## Short

- Each tab loads the VFS from localStorage once, at startup.
- Every change saves that tab's whole in-memory copy, without re-reading.
- Ask in tab A (node X saved), ask in tab B (B saves its copy plus Y): after reload, X is gone.
- A delete in one tab can make the other tab's commit fail with "parent not found".

## Where

- `demo/src/mock/vfs.ts:110-129` (`transaction`)
- `demo/src/mock/runtime.ts:20-23`, `demo/src/mock/demo.ts:79`

## Fix

At depth 0, before `fn()`:

```ts
const current = this.storage.load();
if (current && current !== this.saved) {
  this.restore(current);
  this.saved = current;
}
```

This stops data loss. Other tabs still show stale screens until their next action; a `storage` event listener can fix that later.

## Done when

Two VFS instances sharing one fake storage: write in A, write in B, a fresh load contains both writes.

## Next

Open `demo/src/mock/vfs.ts` at line 110.
