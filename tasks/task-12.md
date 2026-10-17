# Task 12: Temp file names can collide and can be too long

Priority: **Should fix**. Source: repo audit, 2026-10-17.

## Now

1. Developer: use a random temp name in `writeFileAtomic` (`server/src/storage/fs-utils.ts:167-179`). About 5 minutes.

## Short

- Temp name is `.tmp-<basename>-<pid>-<Date.now()>`.
- Two saves of the same file in the same millisecond share it: one rename gets ENOENT (500), and the file may mix both writes.
- With a source name at the 240-byte cap, the temp name is about 265 bytes: ENAMETOOLONG on Linux (255-byte limit). APFS accepts it.

## Where

`server/src/storage/fs-utils.ts:167-179`

## Fix

```ts
const temp = path.join(path.dirname(target), `${TEMP_PREFIX}${randomUUID()}`);
```

`randomUUID` comes from `node:crypto`. The `.tmp-` prefix keeps it hidden from hierarchy and agent as before.

## Done when

Existing storage tests pass; a test writing a 240-byte source name succeeds.

## Next

Open `server/src/storage/fs-utils.ts` at line 167.
