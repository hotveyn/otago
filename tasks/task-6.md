# Task 6: Live updates loop forever once the snapshot passes 1 MB

Priority: **Must fix** (app stops syncing). Source: repo audit, 2026-10-17.

## Now

1. Developer: check the backlog before writing in `openSse` (`server/src/routes/sse.ts:50-55`). About 5 minutes.
2. Developer: update the slow-consumer test (`server/test/sse.test.ts:97`). About 15 minutes.

## Short

- `write()` writes first, then destroys the stream if `writableLength` is over the cap.
- Right after a write, `writableLength` equals the size of that write, so one event over 1 MiB always kills the stream.
- The first event is a snapshot of every running and failed answer in all trees; failed ones are kept 24 h.
- Past 1 MiB (about 500K Cyrillic characters), each tab reconnects, gets the same snapshot, is cut off again, forever.

## Where

- `server/src/routes/sse.ts:50-55`
- Cap: `server/src/routes/questions.ts:184`

## Fix

```ts
const write = (chunk: string) => {
  if (!writable()) return;
  // The client does not read fast enough: drop it; it reconnects and gets a fresh snapshot.
  if (raw.writableLength > options.maxBufferedBytes) {
    raw.destroy();
    return;
  }
  raw.write(chunk);
};
```

## Done when

- A snapshot bigger than the cap reaches the client.
- A client that stops reading is still dropped on the next write.

## Next

Open `server/src/routes/sse.ts` at line 50.
