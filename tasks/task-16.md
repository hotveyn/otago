# Task 16: The demo hand-copies server helpers, and the copies drifted

Priority: **Should fix** (duplication). Source: repo audit, 2026-10-17.

## Now

1. Developer: move the pure parts of `paths.ts` into a Node-free server module and import it from the demo. About 1 hour.
2. Developer: do the same for the attachment type table and user-file rules. About 1 hour.

## Short

- The demo re-implements server rules because the server modules import `node:path`/`node:fs`.
- The attachment `TYPES` table in the demo lacks zip, gz, tar, mp3, wav, mp4, webm, docx, xlsx, pptx.
- So a `.mp4` attachment is served as `application/octet-stream` in the demo.
- Any future change to trash names or tree ids will drift the same way.
- The pattern already exists: `node-names.ts` and `suggestions.ts` are Node-free and shared.

## Copies

| Demo copy | Server original |
|---|---|
| `demo/src/mock/names.ts:10-135` | `server/src/storage/paths.ts` (`toTreeId`, `DELETED_NAME_RE`, `parseTrashId`, reserved names) |
| `demo/src/mock/files.ts:15-96` | `server/src/storage/attachments.ts:46-140` |
| `demo/src/mock/files.ts:175-222` | `server/src/storage/user-files.ts` |
| `demo/src/mock/demo.ts:20-24` | `server/src/config.ts:24-28` (`DEFAULT_MODELS`) |

`demo/src/mock/trees.ts:78-84` (`topLevelIds`) is another small copy.

## Fix

Split each server file into a Node-free part (rules, regexes, tables) and the fs part. Import the Node-free file directly (not via `storage/index.ts`), then delete the demo copies.

## Done when

`demo/src/mock/names.ts` and the copied parts of `files.ts` are gone; all three test suites pass.

## Next

Open `demo/src/mock/names.ts` and list which exports are copies.
