# Plan — `chat-file-attachments` / project `server`

Stack: Fastify 5.12, `@fastify/multipart` 10.1.2, zod 4, fastify-type-provider-zod 7, Claude Agent SDK, vitest. Root: `server/`.
Contract (owner = this project): `.claude/features/chat-file-attachments/contracts/` (`user-files.ts`, `messages.ts`, `http.ts`, `agent.ts`, `shared.ts`). Implement strictly to it.

There is no codegen in this repo (no OpenAPI/gRPC). The web mirrors the types by hand, which is the web plan's job. No new npm dependencies are needed.

## 1. Decisions (feature.md open questions)

| Question | Decision | Why |
|---|---|---|
| Transport | Single `POST /trees/:tree/messages`. The JSON body is unchanged when there are no files. Otherwise `multipart/form-data`: a `payload` JSON text field **first**, then 1..10 `files` parts. The response is the same SSE. | Atomic with the node rename, no staging GC, one abort path. Upload-first needs TTL staging and orphan cleanup, which conflicts with "no DB, atomic". |
| Folder | `<node>/files/` (`USER_FILES_DIR`), added to `RESERVED_NODE_NAMES` and `RESERVED_ROOT_NAMES`. | Separate from agent `attachments/`, so user and agent files never overwrite each other. The web research already assumed `files`. |
| Empty text | Allowed iff ≥ 1 file. `node.md` stores `""`. The agent gets `EMPTY_TEXT_QUESTION`. The namer gets `Attached files: a, b`. Empty text with no files → 400 `empty_message`. | Pasting a screenshot and pressing Enter is the natural flow. |
| User file URL | `GET /trees/:tree/files?node=&name=[&download=1]` | Node ids contain `/`. Mirrors `/attachments` exactly. |
| `done` | `{ nodeId, attachments, files }` | The web seeds the chain cache from `done` and does not refetch. |

### Validating the transport against Fastify 5 / @fastify/multipart 10.1.2 (read from `node_modules/@fastify/multipart/index.js`)
- `request.parts(opts)` builds busboy options as `deepmergeAll({headers}, pluginOptions, opts)`. So **per-call `limits` override the global `files: 1`** for this route only. The sources route (`request.file()` with no opts) keeps `files: 1`. The global registration in `app.ts` stays untouched.
- File size: busboy truncates at `limits.fileSize` and emits `limit`. The plugin records `RequestFileTooLargeError`, but when we `pipeline(part.file, createWriteStream)` the pipeline ends normally with `part.file.truncated === true`. We must check `truncated` ourselves and throw 413.
- Count: `limits.files` hit → `FilesLimitError` (413, "reach files limit"), delivered lazily via the iterator. The contract wants a **400** with a clear message, so pass `files: MAX_MESSAGE_FILES + 1` to busboy as a hard stop and count parts ourselves. On the 11th file part, throw `too_many_files` (400) before reading it.
- Fields: `fields: 1`, `fieldSize: MESSAGE_PAYLOAD_MAX_BYTES`, `parts: MAX_MESSAGE_FILES + 2`. A second field → `FieldsLimitError` (413) or our structural check → 400. Map plugin errors (`FST_FIELDS_LIMIT`, `FST_PARTS_LIMIT`, `FST_INVALID_JSON_FIELD_ERROR`, `FST_PROTO_VIOLATION`) to 400 `invalid_payload`, `FST_FILES_LIMIT` to 400 `too_many_files`, and `FST_REQ_FILE_TOO_LARGE` to 413 `file_too_large`.
- A `payload` part sent with `content-type: application/json` arrives already parsed by the plugin (`value` is an object). A plain `FormData.append('payload', string)` arrives as a string. Accept both.
- There must be no route `body` schema. For multipart requests `request.body` is `undefined` (no `attachFieldsToBody`), so a Zod body schema would reject them. Validation moves into the handler (see §3 `messages.ts`), with the same `{ error: 'Invalid input', details }` shape.
- Bounded memory: each file is streamed straight to disk. Only e-books are read back into memory (≤ 20 MiB, one at a time) for `extractEbookText`, the same as the sources upload. No `toBuffer()` for files.
- Everything happens **before** `reply.hijack()`. Any throw goes through the normal error handler as a JSON 4xx. SSE starts only after all files are staged and validated.

## 2. Files to create

| Path | Purpose |
|---|---|
| `server/src/storage/user-files.ts` | Contract constants (mirrored from `contracts/user-files.ts`), extension matching, name resolution/sanitizing, `UserFileInfo`, `listUserFiles`, `userFilePath`, `userFileContentTypeOf`, magic-byte check, and the staging writer `createUserFileStager` |
| `server/src/routes/message-input.ts` | Request decoding for the messages route: `openMessageInput(request)` returns JSON or multipart input; `receiveUserFiles(parts, stager)`; plugin-error mapping; `drainParts` |
| `server/src/routes/user-files.ts` | `GET /trees/:tree/files` serving route (mirror of `routes/attachments.ts`) |
| `server/test/user-files.test.ts` | Unit tests for storage/user-files |
| `server/test/message-files-api.test.ts` | Integration tests: multipart messages, `done.files`, chain `files`, serving route, prompt paths, atomicity |

No runtime files go under `contracts/`, and the contract spec is not copied into `server/`. Constants are re-declared in `user-files.ts` with a `// mirrors .claude/features/chat-file-attachments/contracts/user-files.ts` comment.

## 3. Files to change

### `server/src/errors.ts`
- `AppError` gets an optional 4th constructor arg, `details?: unknown`.
- New `export type UploadErrorCode = 'invalid_payload' | 'empty_message' | 'too_many_files' | 'unsupported_file_type' | 'empty_file' | 'unreadable_file' | 'file_too_large'`.
- New `class UploadError extends AppError` with constructor `(message, code: UploadErrorCode)`. Status is 413 for `file_too_large` and 400 for every other code.
- New `class InvalidBodyError extends AppError`: 400, message `'Invalid input'`, carries Zod `details`. It is used for manual Zod validation of the message body/payload, so the error shape stays identical to route-schema errors.
- Widen the `AppError.code` type to `ConflictCode | UploadErrorCode | string`.

### `server/src/app.ts`
- Error handler: include `details` when the `AppError` has it: `{ error, ...(code && {code}), ...(details !== undefined && {details}) }`.
- Move `MAX_SOURCE_BYTES` to `storage/sources.ts` (to avoid a `storage → app` import cycle) and keep `export { MAX_SOURCE_BYTES } from './storage/index.js'` in `app.ts` for compatibility. The global multipart registration is **unchanged** (`fileSize: MAX_SOURCE_BYTES, files: 1`).
- Register `userFileRoutes` next to `attachmentRoutes`.

### `server/src/storage/paths.ts`
- `export const USER_FILES_DIR = 'files'` (doc: "user files of the message that created the node").
- `RESERVED_NODE_NAMES = new Set([ATTACHMENTS_DIR, USER_FILES_DIR])`, `RESERVED_ROOT_NAMES` adds `USER_FILES_DIR`.
- `nodeIdSegments`, `readChildren` and `claimUniqueName` callers need no code change: they already consult these sets.

### `server/src/storage/sources.ts`
- Add `export const MAX_SOURCE_BYTES = 20 * 1024 * 1024`.
- `saveSource` passes the label `sources/<name>` to `extractEbookText` (see ebooks). No behaviour change.

### `server/src/storage/ebooks/index.ts`
- `extractEbookText(name, data, label = \`sources/${name}\`)`. The header comment becomes `<!-- Text extracted by Otago from ${label} -->`. User files pass `files/<storedName>`. Existing tests stay valid (default label).

### `server/src/storage/fs-utils.ts`
- `uniqueFileName(taken, name, maxLength = 120, extension?: string)`. When `extension` is given and `name` ends with it, the `-N` suffix goes before that whole extension (`book.fb2.zip` → `book-2.fb2.zip`). Otherwise the current behaviour applies. Existing callers are unchanged.

### `server/src/storage/attachments.ts`
- Export the existing `cleanStem` as `cleanFileStem`, so user-file naming reuses the exact same safe-name rules. Also export `infoOf` as `attachmentInfoOf`, or re-derive it in user-files.
- No behaviour change for agent attachments.

### `server/src/storage/user-files.ts` (new): contents
- Constants: `MAX_MESSAGE_FILES = 10`, `MAX_MESSAGE_FILE_BYTES = MAX_SOURCE_BYTES`, `MESSAGE_FILE_EXTENSIONS` (longest first; built from `TEXT_SOURCE_EXTENSIONS` + `EBOOK_EXTENSIONS` + images, then sorted by length desc), `IMAGE_MIME_EXTENSIONS`, `DEFAULT_PASTED_STEM`, `USER_FILE_NAME_PATTERN` (= `ATTACHMENT_NAME_PATTERN`).
- `userFileExtensionOf(name): string | undefined`: lowercase longest-suffix match that requires a non-empty stem.
- `resolveUserFileName(filename, mimetype): { stem, ext }`:
  - Take the basename after the last `/` or `\`.
  - Try the allowed extension. If none matches and `mimetype` is in `IMAGE_MIME_EXTENSIONS`, use that extension and keep the filename's own stem (after stripping any trailing unknown extension such as `.bin`).
  - Otherwise throw `UploadError('Unsupported file type "<orig>". Allowed: …', 'unsupported_file_type')`.
- `userFileName(stem, ext, maxLength)`:
  - `cleanFileStem(stem)`, or `DEFAULT_PASTED_STEM` for images and `file` otherwise when the cleaned stem is empty.
  - Truncate the stem to `120 - ext.length` (e-books: `120 - ext.length - 3`, so the `.md` companion fits).
  - Assert the result against the pattern.
- `userFileContentTypeOf(name)`: `ebookContentType(name) ?? attachmentContentTypeOf(name)`. `userFileKindOf(name)`: `attachmentKindOf(name)` (e-books → `other`).
- `listUserFiles(nodeDir): Promise<UserFileInfo[]>`:
  - `readdir(<nodeDir>/files)`; ENOENT/ENOTDIR → `[]`.
  - Keep only regular files matching the pattern. Skip `.part-*` (dotfiles fail the pattern anyway).
  - Fold `<book>.md` companions into `text` (same algorithm as `listSources`).
  - Sort by name, ASCII.
- `userFilePath(treeDir, nodeId, name)`: `assertUserFileName` (400 `Invalid file name`), then `resolveInside(nodeDirOf(...), USER_FILES_DIR, name)`.
- `checkSignature(ext, head: Buffer)`: reads the first 12 bytes after writing and checks them:
  - PNG `89 50 4E 47 0D 0A 1A 0A`
  - JPEG `FF D8 FF`
  - GIF `GIF87a` / `GIF89a`
  - WEBP `RIFF....WEBP`
  - PDF `%PDF-`

  A mismatch throws `UploadError('"<orig>" is not a valid <TYPE> file', 'unreadable_file')`. Text and e-book files are not sniffed; e-books are validated by extraction.
- `createUserFileStager({ stagingDir, signal })` returns a `UserFileStager`:
  - Private state: `taken: Set<string>`, `files: UserFileInfo[]`, `count`, and `dir = <stagingDir>/files`, created lazily with `mkdir`.
  - `addFromStream({ filename, mimetype, stream }): Promise<UserFileInfo>`. The steps below are the **single validation/staging path**:
    1. `count >= MAX_MESSAGE_FILES` → `too_many_files`.
    2. `resolveUserFileName` rejects unsupported types **before any byte is written**. The stream is then left unconsumed; the caller drains it.
    3. `pipeline(stream, createWriteStream(<dir>/.part-<uuid>), { signal })`.
    4. `stream.truncated` → 413 `"<orig>" is larger than 20 MB`.
    5. `size === 0` → `empty_file`.
    6. Signature check for images/PDF.
    7. Reserve the name: `uniqueFileName(taken, userFileName(...), 120, ext)`. For e-books, also reserve the companion, and loop while the companion is taken.
    8. `rename(part, <dir>/<name>)`.
    9. E-books only: `extractEbookText(name, await readFile(target), \`files/${name}\`)` → `writeFile(<dir>/<name>.md)`. An `InvalidInputError` from extraction is rethrown as `UploadError(msg, 'unreadable_file')`.
    10. Push the `UserFileInfo`.

    On any error, `rm` the part/target/companion (best effort) and rethrow. The staging discard is the final safety net.
  - `addFromFile({ path, requestedName, contentType })`: **not implemented now**. Document it as the seam for attach-from-URL, where `downloadToFile` writes the `.part-` file and steps 4–10 are shared. Implement steps 4–10 as a private `commitPart(partPath, orig, stem, ext)` so the future `addFromUrl` just calls `downloadToFile` + `commitPart`.
  - `list(): UserFileInfo[]`: the staged infos in the order they arrived.
  - `promptFiles(treeDir): PromptFile[]`: paths relative to `treeDir` (`path.relative(treeDir, dir)/<name>`, e-books → `<name>.md`), using POSIX separators.
- `nodePromptFiles(nodeId, files: UserFileInfo[]): PromptFile[]`: helper for chain nodes (`<nodeId>/files/<name>` or `<text>`).
- Re-export from `storage/index.ts`.

### `server/src/storage/nodes.ts`
- `ChainNode` gets `files: UserFileInfo[]` (doc: "Files in `<node>/files/` (user uploads), sorted by name."). `readChain` fills it with `listUserFiles(nodeDir)`.
- `createNode` needs no change: `stagingDir` already carries `files/` along in the rename. Update the `CreateNodeOptions.stagingDir` doc to mention `files/`.

### `server/src/routes/message-input.ts` (new)
- `messageBody`: the existing JSON schema (moved here), unchanged, with `text` min(1).
- `messagePayload`: the same fields but `text: z.string().trim().max(50_000).default('')`. Unknown keys are stripped (this is the future `urls` seam).
- `type MessageInput = { kind: 'json'; body } | { kind: 'multipart'; body; parts: AsyncIterableIterator<Multipart> }`.
- `openMessageInput(request)`:
  - **Not multipart:** `messageBody.safeParse(request.body)`. On failure throw `InvalidBodyError(issues)`.
  - **Multipart:**
    1. `parts = request.parts({ limits: { files: MAX_MESSAGE_FILES + 1, fileSize: MAX_MESSAGE_FILE_BYTES, fields: 1, fieldSize: MESSAGE_PAYLOAD_MAX_BYTES, parts: MAX_MESSAGE_FILES + 2 } })`.
    2. Read the first part with `await parts.next()`. It must be a field named `payload`, else throw `UploadError('The "payload" field must come first', 'invalid_payload')`.
    3. `JSON.parse` when it is a string (a parse error → `invalid_payload`), then `messagePayload.safeParse` (failure → `InvalidBodyError`).
    4. Wrap the whole thing in `mapMultipartError`.
- `receiveUserFiles(parts, stager)`: for each remaining part, `type !== 'file' || fieldname !== 'files'` → `invalid_payload`. Otherwise `stager.addFromStream({ filename, mimetype, stream: part.file })`. Plugin errors from the iterator are mapped (see §1).
- `drainParts(parts)`: best-effort consumption of any remaining parts (`part.file.resume()` and await end), swallowing errors. It is called after a pre-stream error on multipart requests, so the browser receives the 400/413 instead of a connection reset (fetch over HTTP/1.1 may report a reset when the server replies and closes mid-upload). It is bounded by the limits and skipped when the socket is already closed.
- `mapMultipartError(error)`: maps `FST_*` codes to `UploadError` (§1). `FST_MP_PREMATURE_CLOSE` passes through (the client is gone anyway).

### `server/src/routes/messages.ts`
Restructure the handler. Remove `body: messageBody` from the route schema (keep `params`). New order:
1. `input = await openMessageInput(request)`. `text = input.body.text`.
2. `pickModel` × 2 (unchanged). `treeDir = await existingTreeDir(...)`.
3. JSON path only: `text` is already ≥ 1 char by schema.
4. `release = locks.acquireShared(treeId)`, then create the `controller`. Move `onClose` so it is attached to `reply.raw` **here**, before the upload, so a client disconnect during upload aborts `controller`, which stops the `pipeline`.
5. `try`:
   - `readTree`, `readChain`, `sweepStaleStaging`, `createAnswerStaging` (unchanged).
   - Then, if multipart: `stager = createUserFileStager({ stagingDir: staging.dir, signal })` and `await receiveUserFiles(input.parts, stager)`.
   - Then `if (!text && files.length === 0) throw new UploadError('Message is empty: type a question or attach a file', 'empty_message')`.
   - `catch`: `await staging?.discard()` (discard also calls release), then `release()`, then `if (multipart) await drainParts(input.parts)`, then rethrow.
   - The JSON path keeps today's behaviour exactly.
6. `reply.hijack()` + SSE headers (unchanged; `onClose` is already attached).
7. `question = text || EMPTY_TEXT_QUESTION`. `namingQuestion = text || \`Attached files: ${names.join(', ')}\``. `fallbackNodeName(namingQuestion)`. When `text` is empty and all names sanitize to nothing, the fallback slug `node` is fine.
8. `agent.ask({ …, question, files: stager?.promptFiles(treeDir) ?? [] })`.
9. `createNode(..., { user: text, ... }, { stagingDir: staging.dir })` (unchanged; `files/` moves with it).
10. `const nodeDir = nodeDirOf(treeDir, newId)`, then `send('done', { nodeId: newId, attachments: await listAttachments(nodeDir), files: await listUserFiles(nodeDir) })`.
11. `finally` stays the same (discard when not committed, release, end). `staging.seal()` removes only an empty `attachments/`, so it does not touch `files/`. Confirm this in a test.

### `server/src/routes/user-files.ts` (new)
Copy of `routes/attachments.ts` with these differences:
- the path is `/trees/:tree/files`;
- names are checked with `assertUserFileName` and paths built with `userFilePath`;
- `content-type: userFileContentTypeOf(name)`;
- the 404 message is `File not found: <name>`.

Reuse `ATTACHMENT_CSP`. Import it from `routes/attachments.ts`, or move it to a shared `routes/file-headers.ts` helper `fileResponseHeaders(name, size, contentType, download)` used by both routes (preferred, as it removes duplication). The route is read-only and takes no lock.

### `server/src/agent/types.ts`
- `AskInput.chain`: `Pick<ChainNode, 'id' | 'user' | 'assistant' | 'attachments' | 'files'>[]`.
- `AskInput.files: PromptFile[]`: the current message's readable files, relative to `treeDir`. Default `[]` from callers.
- Export `PromptFile` (defined in `storage/user-files.ts` or `agent/types.ts`; agent/types is preferred, with storage importing only the type).

### `server/src/agent/prompt.ts`
- `buildUserPrompt(chain, question, files: PromptFile[] = [])`. Chain items gain an optional `files?: UserFileInfo[]`.
- Inside the transcript, per node, after `<user>` and before `<assistant>`: `<files>` lines from `nodePromptFiles(node.id, node.files)`, formatted as:
  - `<path> (<kind>, <size> bytes)`;
  - e-books: `<id>/files/<book>.md (text extracted from <book>, <size> bytes)`.

  Only when `node.id` is set and the node has files.
- After `Continue the conversation above. New question:` (or at the top when the chain is empty): a `<files>` block for `files`, then `question.trim()`.
- `SYSTEM_RULES`: add a "User files" block with the semantics in `contracts/agent.ts`:
  - read the listed paths;
  - e-books → `.md`;
  - the current message's files come first, before `sources/`;
  - citation form `files/<name>:<a>-<b>` / `<node-id>/files/<name>:<a>-<b>`;
  - never mention `.tmp-answer-…`;
  - never link user files as `attachments/…`.

  Adjust rule 1 ("Search `sources/` first") to "…first, unless the user attached files for this question — then read those first".

### `server/src/agent/claude-agent.ts`
- `buildUserPrompt(input.chain, input.question, input.files)`. Nothing else: Read already works in `cwd = treeDir`, including images and PDFs, and the staging dir sits inside the tree.

### `server/test/helpers.ts`
- `fakeAgent`: store `calls` as today. Optionally add a `onAsk?(input)` hook so tests can assert that the files exist on disk at ask time.
- New `multipartMessage(payload: object | string | null, files: Array<{ name: string; content: string | Uint8Array; type?: string }>, opts?: { payloadLast?: boolean; payloadField?: string; extraField?: [string, string] })` builds a raw multipart body with a boundary (same technique as `multipartBody`).
- A tiny `pngBytes()` fixture: a valid 1×1 PNG.

## 4. Data-model changes
- On disk: new optional folder `<node>/files/` with user files plus `<book>.md` companions. `node.md` format is unchanged; `user` may now be empty.
- Reserved names: `files` at every level and at the root.
- API: `ChainNode.files`, `done.files`, new `GET /trees/:tree/files`, the multipart variant of `POST /messages`, and new error `code`s. All of these are additive.

## 5. Step ordering
1. `errors.ts` (UploadError, InvalidBodyError, details) + the `app.ts` error handler + move `MAX_SOURCE_BYTES`.
2. `paths.ts` reserved `files`; `fs-utils.uniqueFileName` extension arg; `ebooks.extractEbookText` label; export `cleanFileStem`.
3. `storage/user-files.ts` + `test/user-files.test.ts`.
4. `nodes.ts` chain `files`; chain tests.
5. `routes/user-files.ts` (+ optional shared header helper) and registration.
6. `agent/types.ts`, `prompt.ts` (+ SYSTEM_RULES), `claude-agent.ts`; prompt tests in `agent.test.ts`.
7. `routes/message-input.ts` + `messages.ts` restructure; `helpers.ts`; `test/message-files-api.test.ts`.
8. Run `pnpm --filter @otago/server test`, then `pnpm --filter @otago/server lint`. For formatting use `pnpm --filter @otago/server format` (terminal command only; never hand-format).

## 6. Test plan

### `test/user-files.test.ts` (unit)
- **Extension matching:**
  - `.fb2.zip` wins;
  - `x.zip` is rejected;
  - `A.PDF` is accepted and stored as `A.pdf`;
  - `.png` alone (empty stem) → pasted stem;
  - no extension + `image/png` → `.png`;
  - no extension + `application/pdf` → rejected (only images use the MIME fallback);
  - `evil.exe` with `image/png` MIME: the name resolves to `evil.png` (MIME fallback), and the magic-byte check then rejects non-PNG content with `unreadable_file`. Assert both steps.
- **Names:**
  - traversal `../../x.md` → `x.md`;
  - unicode `Résumé 1.txt` → `Resume-1.txt`;
  - 300-char name ≤ 120;
  - e-book long name → companion ≤ 120;
  - duplicates → `a-2.png`, and `book.fb2.zip` ×2 → `book-2.fb2.zip`;
  - uploading `book.epub` plus `book.epub.md` → the second becomes `book.epub-2.md`, so the companion is not overwritten.
- **Stager:**
  - a stream larger than a small test `fileSize`, simulated with a `truncated` flag on the stream object → 413 and no leftovers;
  - empty → `empty_file`;
  - bad PNG bytes → `unreadable_file`;
  - an invalid epub → `unreadable_file` and no files left;
  - a valid fb2 → companion written, header says `files/<name>`;
  - 11th add → `too_many_files`;
  - abort signal → rejects, part removed.
- **`listUserFiles`:** missing folder → `[]`; companion folded into `text`; `.part-*` and bad names skipped; sorted.
- **`promptFiles`:** relative POSIX paths into staging, with e-books pointing at `.md`.

### `test/storage.test.ts`
- `createNode(..., 'files')` → `files-2` at root and nested.
- `nodeIdSegments('a/files')` and `('files')` throw.
- `readHierarchy` ignores a `files/` folder that contains a `node.md`.
- `readChain` returns `files: []` for old nodes and lists files for a node that has them.

### `test/agent.test.ts`
- `buildUserPrompt`:
  - an ancestor `<files>` block sits inside the transcript with `<id>/files/<name>`;
  - an e-book line points at `.md`;
  - the current `files` block comes before the question, both with and without a chain;
  - no block when there are no files (existing snapshots unchanged).
- `SYSTEM_RULES` mentions `files/` and the `.tmp-answer` warning.

### `test/message-files-api.test.ts` (integration, `app.inject`, fake agent)
- **Happy path**, with `payload` + `notes.md` + a nameless PNG (`filename=""`, `image/png`) + a duplicate `notes.md`:
  - the response is 200 SSE;
  - `done.files` = `[notes-2.md, notes.md, pasted-image.png]`, sorted, with sizes and kinds;
  - the files are on disk under `<node>/files/`;
  - `GET /chain` has the same `files`;
  - `attachments` is unaffected;
  - `node.md` user text is intact.
- **Agent input:** `calls[0].files` paths exist on disk at ask time (via the `onAsk` hook) and live under `.tmp-answer-`. The prompt contains them.
- **E-book:** a valid fb2 → `files` entry with `text: '<name>.md'`; the companion is servable. An invalid epub → 400 `unreadable_file`, no node, no `.tmp-answer-*` left, lock released (a follow-up move succeeds).
- **Rejections, each asserting status + `code`, no node, no staging dir left, lock released:**
  - unsupported `.docx` → 400;
  - 11 files → 400 `too_many_files`;
  - 0-byte → 400 `empty_file`;
  - `MAX_MESSAGE_FILE_BYTES + 1` → 413 `file_too_large` (a 20 MiB buffer is acceptable in tests);
  - payload missing / after files / bad JSON / extra field `foo` → 400 `invalid_payload`;
  - a Zod-invalid payload (`parentId: '../x'`) → 400 `Invalid input` with `details`;
  - an unknown parent → 404;
  - an unknown model → 400;
  - empty text + no files (multipart) → 400 `empty_message`.
- **Empty text + 1 file** → 200. `node.md` user is `""`. The agent question is `EMPTY_TEXT_QUESTION`. The naming call receives `Attached files: …`.
- **Atomicity:**
  - agent `failAfter` → SSE `error`, no node, no staging, no files;
  - client disconnect during the stream (existing pattern) → nothing written.
- **Structural lock:** a move while a multipart stream is gated → 409 `tree_busy_streaming`.
- **Visibility:**
  - a follow-up JSON message from the child node → the prompt's transcript lists `<child>/files/<name>`;
  - a sibling branch message from the same parent → the prompt does not list them.
- **Backward compatibility:**
  - the JSON path is unchanged (existing `messages-api.test.ts` stays green and stays untouched apart from `done` now containing `files: []`; add that assertion);
  - `POST /sources` with 2 files still fails (the `files: 1` limit is preserved).
- **`GET /files`:**
  - 200 with the correct content-type, `content-disposition` inline vs `download=1`, nosniff, CSP;
  - 404 for an unknown node or file;
  - 400 for a bad name (`..`, `/`);
  - the `attachments` route cannot read a user file and vice versa (a same-name file in both folders returns different bytes).

## 7. Risks / notes
- **An existing node named `files`** would become hidden once `files` is reserved (the same trade-off `attachments` made). This is unlikely given 2–4-word names. Call it out in the changelog.
- **Early replies during upload:** replying 400/413 before the body is consumed can surface as a network error in browsers. `drainParts` mitigates it. `inject()` cannot reproduce this, so verify manually once through the Vite proxy.
- **The shared lock is held during upload.** Move/delete get a 409 while the user uploads, which is consistent with the "stream in progress" semantics.
- **Staging paths are shown to the agent** (`.tmp-answer-…`). The system rules forbid citing them, and the agent answer is never rewritten. If a leak shows up in practice, a later tweak could post-process `.tmp-answer-XXXX/files/` → `files/` in the final text before `createNode` (not planned now).
- **`sweepStaleStaging`** never touches active staging, so a long upload is safe.
- **Future attach-from-URL:** `payload.urls` → `stager.addFromUrl` = `downloadToFile(part)` + the shared `commitPart`, counted against `MAX_MESSAGE_FILES`. No contract break.
