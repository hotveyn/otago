# Task 5: A small e-book file can crash the server

Priority: **Must fix** (crash, loss of in-flight answers). Source: repo audit, 2026-10-17.

## Now

1. Developer: cap the unzipped size in `unzipBook` (`server/src/storage/ebooks/epub.ts:24-30`). About 20 minutes.
2. Developer: cap the output of `palmDocDecompress` (`server/src/storage/ebooks/mobi.ts:159-177`). About 10 minutes.

## Short

- fflate's `unzipSync` sets aside as much memory as each entry claims, with no cap.
- A 20 MB `.epub` or `.fb2.zip` with entries claiming 1 GB each needs about 20 GB of memory: the process dies.
- All running questions and the in-memory registry die with it.
- `palmDocDecompress` collects output into an unbounded `number[]`.
- Conversion also runs on the event loop, so big honest books freeze SSE for seconds (accepted for now).

## Where

- `server/src/storage/ebooks/epub.ts:24-30` (`unzipBook`)
- `server/src/storage/ebooks/fb2.ts:146-151`
- `server/src/storage/ebooks/mobi.ts:159-177`
- Callers: `server/src/storage/sources.ts:126`, `server/src/storage/user-files.ts:365`

## Fix

1. `unzipSync(data, { filter: (f) => { total += f.originalSize; if (total > 200 * 1024 * 1024) throw new EbookError('archive too large'); return true; } })`. Let `EbookError` pass through the existing `catch`.
2. In `palmDocDecompress`, throw once output passes 64 KB (MOBI text records are 4096 bytes uncompressed).

## Done when

A test zip whose entry declares a huge `originalSize` is rejected with `EbookError` before any big allocation.

## Next

Open `server/src/storage/ebooks/epub.ts` at line 24.
