# Plan — `chat-file-attachments` / project `web`

Role: **client**. Root: `web/`. Stack: React 19.3, Vite 8, TanStack Query 5, TypeScript 7, Biome, Vitest 5 (node environment, no jsdom).

Contract (read-only, owner = server): `.claude/features/chat-file-attachments/contracts/` (`user-files.ts`, `messages.ts`, `http.ts`, `shared.ts`). The server is already implemented, and it matches the contract. I checked `server/src/routes/message-input.ts`, `routes/user-files.ts`, and the `done` payload in `routes/messages.ts`.

There is no codegen. The web mirrors the types and constants by hand in `web/src/api/types.ts` and `web/src/lib/chat-files.ts`, each with a `// mirrors .claude/features/chat-file-attachments/contracts/<file>` comment. No new npm dependencies are needed.

## 1. Contract points the web implements (summary)

| Contract | Web consequence |
|---|---|
| `POST /messages`: JSON when there are no files (unchanged). Multipart when there is ≥ 1 file: `payload` (JSON string of `MessagePayload`) **first**, then `files` parts | `buildMessageBody()` chooses the encoding. Never set `content-type` for FormData. |
| Empty text allowed iff ≥ 1 file (`EMPTY_MESSAGE_ALLOWED_WITH_FILES`) | `canSend(text, files, streaming)` = `!streaming && (text.trim() !== '' \|\| files.length > 0)`. |
| Server validates everything before the 200 headers | Pending phase: `'uploading'` until `res.ok`, then `'answering'`. Only when files were sent. |
| `done` = `{ nodeId, attachments, files: UserFileInfo[] }` | `MessageDone.files`, defaulted to `[]`. Seed the chain cache with it. |
| `ChainNode.files: UserFileInfo[]` | Add the field. `api.getChain` defaults it to `[]` (older server). |
| `GET /api/trees/:tree/files?node=&name=[&download=1]` | `userFileUrl()` plus a folder-aware fetch, URL builder, and query keys. |
| `UserFileInfo` = `AttachmentInfo` minus `origin`, plus `text?` (e-book companion) | Reuse `AttachmentCard`/`AttachmentViewer` with `folder: 'files'`. For e-books, "Preview text" opens the companion. |
| Error codes `invalid_payload`, `empty_message`, `too_many_files`, `unsupported_file_type`, `empty_file`, `unreadable_file`, `file_too_large` (413) | Widen `ApiError.code`. The server `error` text is shown as-is (it names the original file). |
| `MAX_MESSAGE_FILES = 10`, `MAX_MESSAGE_FILE_BYTES = 20 MiB`, `MESSAGE_FILE_EXTENSIONS` (longest suffix, `.fb2.zip` first, plain `.zip` rejected), `IMAGE_MIME_EXTENSIONS` | Mirrored in `lib/chat-files.ts`. `<input accept>` uses `.zip`, not `.fb2.zip` (browser bug). |
| The UI must show the server's stored name after commit | Pending shows the local names. Committed rows use `done.files` / chain. |
| Future `urls?: string[]` in `payload` | Name the seams (`ComposerItem`, `buildMessageBody`) so a URL item can be added. Do not implement it. |

## 2. Files to create

| Path | Purpose |
|---|---|
| `web/src/lib/chat-files.ts` | Mirrored constants and pure helpers: `MESSAGE_PAYLOAD_FIELD`, `MESSAGE_FILES_FIELD`, `MAX_MESSAGE_FILES`, `MAX_MESSAGE_FILE_BYTES`, `MESSAGE_FILE_EXTENSIONS`, `MESSAGE_IMAGE_EXTENSIONS`, `IMAGE_MIME_EXTENSIONS`, `CHAT_FILE_ACCEPT`, `chatFileExtensionOf`, `isChatImage`, `validateChatFiles`, `normalizePastedFile`, `pastedFilesToAdd`, `canSend`, `restoreFiles`, `ComposerFile`/`RejectedFile` types, `toComposerFiles`, `allowedTypesLabel` |
| `web/src/lib/chat-files.test.ts` | Unit tests for the above |
| `web/src/components/chat/ComposerFiles.tsx` | Chip list of the composer (badge, name, size, image thumb, remove button) plus the rejection list and the live region |
| `web/src/components/chat/LocalThumb.tsx` | `<img>` for a local `File`. Creates the object URL in `useEffect` and revokes it in the cleanup |
| `web/src/components/chat/UserFileList.tsx` | Files under a user message. Committed: `AttachmentCard folder="files"`. Pending: local rows built from `File`s |
| `web/src/lib/use-file-drop-guard.ts` | `useFileDropGuard()`: window `dragover`/`drop` listeners that stop the browser from navigating to a dropped file outside a drop zone |

Do not create anything under `contracts/`. Do not copy the contract into `web/`.

## 3. Files to change

### 3.1 `web/src/api/types.ts`
- Header: also mention `.claude/features/chat-file-attachments/contracts`.
- New `export type FileFolder = 'attachments' | 'files';` (web-only).
- New `export interface UserFileInfo { name; size; contentType; kind: AttachmentKind; text?: string }`. Copy the contract doc comments.
- `ChainNode.files: UserFileInfo[]` ("Files the user attached to this message, in `<node>/files/`; `[]` for older nodes"). `user` doc: may be `""` for a files-only message.
- `MessageDone.files: UserFileInfo[]`.
- New `MessageUploadErrorCode` (the 7 codes). `ErrorBody.code?: ConflictCode | MessageUploadErrorCode`.
- New `MessagePayload { parentId; text?; model?; namingModel? }`, with a `// urls?: string[] — reserved by the contract` comment.

### 3.2 `web/src/api/client.ts`
- `ApiError.code` widens to `ConflictCode | MessageUploadErrorCode`. `errorOf` accepts both lists through one `isErrorCode` guard. The `describeError` checks stay valid.
- URL builders:
  - `nodeFileUrl(folder, treeId, nodeId, name, download = false)` returns `/api/trees/<tree>/<folder>?node=…&name=…[&download=1]`;
  - `attachmentUrl` = `nodeFileUrl('attachments', …)`, signature unchanged;
  - new `userFileUrl` = `nodeFileUrl('files', …)`.
- `fetchAttachment` → `fetchNodeFile(folder, …)`. `api.getAttachmentText` / `getAttachmentBlob` get an optional trailing `folder: FileFolder = 'attachments'`.
- `api.getChain`: default `files: item.files ?? []`.
- `SendMessageInput` gains `files?: readonly File[]` and `onAccepted?: () => void` (fired once after `res.ok`, before the stream is read).
- New exported pure function `buildMessageBody(input): { body: string | FormData; headers: Record<string,string> }`:
  - no files: today's JSON body byte-for-byte, with the `content-type: application/json` header;
  - with files: `form.append('payload', JSON.stringify({ parentId, text, model, namingModel }))` FIRST, then `form.append('files', f, f.name)` per file, with **no** content-type;
  - seam comment: a future `urls` goes into `payload`.
- `sendMessage`:
  - build the body with `buildMessageBody`, then `onAccepted?.()` after `res.ok`;
  - `done` resolves `{ nodeId, attachments: done.attachments ?? [], files: done.files ?? [] }`;
  - the SSE loop is otherwise unchanged.
  - `lib/chat-files.ts` must not import `api/client.ts` (no cycle; types only).

### 3.3 `web/src/api/queries.ts`
- `keys.attachment` / `attachmentBlob` gain `folder: FileFolder = 'attachments'`, giving `['attachment', tree, node, folder, name, size]`.
- `useAttachmentText` / `useAttachmentBlob` gain a trailing `folder` argument, passed into the key and the fetch.

### 3.4 `web/src/components/source-viewer-context.ts`
- `AttachmentView.folder?: FileFolder` (default `'attachments'`).

### 3.5 `web/src/components/AttachmentViewer.tsx`
- `folder = view.folder ?? 'attachments'`. Every `attachmentUrl(...)` becomes `nodeFileUrl(folder, ...)`, and the text/blob hooks receive `folder`. The aria-label is `File …` for user files.
- The e-book companion opens as a text view `{ name: text, kind: 'text', contentType: 'text/markdown; charset=utf-8', size: bookSize }`, where the book size is an upper bound for the preview-limit check.

### 3.6 `web/src/components/chat/AttachmentCard.tsx`
- Optional `folder` prop, threaded through `TablePreview`, `ImagePreview` url, the Download href, and `openAttachment({ …, folder })`.
- `info` type widens to `AttachmentInfo & { text?: string }`. For `folder === 'files'` with `text`, add a "Preview text" button.
- `StreamingCard` is unchanged, and so is the agent-attachment output.

### 3.7 `AttachmentInline.tsx`
- No change. `attachments/<name>` links resolve only against agent attachments through `AttachmentScope`. User files are rendered outside it.

### 3.8 `web/src/components/chat/useChatSession.ts`
- `Pending` gains:
  - `files: ComposerFile[]`, the snapshot that was sent;
  - `phase: 'uploading' | 'answering'` (`'uploading'` only when files were sent).
- New state `files: ComposerFile[]` and `fileErrors: RejectedFile[]`.
- `ChatSession` gains `files`, `fileErrors`, `addFiles(File[])`, `removeFile(id)`, `dismissFileErrors()` and `canSend`.
  - `addFiles` uses `validateChatFiles` against the latest list (functional `setFiles`) and replaces `fileErrors` with the rejections.
- `send()`:
  - guard with `canSend(text, files, abort.current !== null)`;
  - clear the draft, files and errors;
  - set `Pending` with `files` and `phase`;
  - call `sendMessage({ …, files: sent.map(f => f.file), onAccepted: () => set phase 'answering' })`;
  - success: seed the chain entry with `user: text` (may be `''`) and `files: done.files`;
  - catch: keep the draft restore, and add `setFiles(current => restoreFiles(current, sent))`. An aborted send still leads to `setPending(null)`.
  - `useCallback` deps gain `files`.

### 3.9 `web/src/components/chat/Exchange.tsx`
- New optional `files?: ReactNode`, rendered inside `.msg-user` after the question.
- The question Markdown renders only when the text is non-empty.
- User files stay outside `AttachmentScope.Provider`.

### 3.10 `web/src/components/chat/ChatThread.tsx`
- Committed: `<UserFileList treeId nodeId files={node.files} />` when there are files.
- Pending: `<UserFileList pending={pending.files} unsaved={pending.error !== null} />`.
- Meta label: 'Not saved' | 'Uploading files…' | 'Answering…'.
- Scroll deps gain `pending?.phase`.

### 3.11 `web/src/components/chat/Composer.tsx`
New props: `files`, `fileErrors`, `onAddFiles`, `onRemoveFile`, `onDismissFileErrors`, and `canSend` (which replaces both `value.trim()` checks).

UI:
- **Attach button** (ghost, sm, `aria-label="Attach files"`) in `.composer-bar`:
  - opens a hidden `<input type=file multiple accept={CHAT_FILE_ACCEPT} hidden>`;
  - `onChange` copies the files, then resets `value = ''`;
  - disabled while streaming or at 10 files.
- **Paste**: `onPaste` uses `pastedFilesToAdd(clipboardData)`. Empty → a normal paste; otherwise `onAddFiles`, with `preventDefault` only when `blockText`.
- **Drag and drop** on the `.composer` root:
  - an enter/leave depth counter (`useRef`) drives the `.composer-drop` class;
  - only react when `types.includes('Files')`;
  - `dragover` calls `preventDefault` and sets `dropEffect` to 'copy', or 'none' while streaming;
  - `drop` resets the counter and adds the files unless streaming (no queuing);
  - add a biome-ignore note: "the Attach button is the keyboard path".
- **Chips**: `<ComposerFiles>` between `.composer-target` and the textarea.
- **Hint**: the textarea gets `aria-describedby`, pointing at a visually hidden hint "You can also paste or drop files."

### 3.12 `ChatView.tsx`, `SideChatView.tsx`
- Pass the new session fields to `<Composer>`.

### 3.13 `App.tsx`
- Call `useFileDropGuard()`.

### 3.14 `styles/base.css`
- `.composer-drop` (reuse the `.panel-drop` look);
- `.composer-files`, `.composer-file`, `.composer-file-errors`;
- `.msg-user .user-files`, `.user-file-pending`, `.user-file-unsaved`;
- `.visually-hidden`, only if it is missing.
- Format with `pnpm --filter @otago/web format`; never format by hand.

## 4. `lib/chat-files.ts` — pure API
```ts
export const MESSAGE_PAYLOAD_FIELD = 'payload';
export const MESSAGE_FILES_FIELD = 'files';
export const MAX_MESSAGE_FILES = 10;
export const MAX_MESSAGE_FILE_BYTES = 20 * 1024 * 1024;
export const MESSAGE_FILE_EXTENSIONS = ['.fb2.zip','.md','.txt','.pdf','.epub','.fb2','.mobi','.azw','.azw3','.png','.jpg','.jpeg','.webp','.gif'] as const;
export const MESSAGE_IMAGE_EXTENSIONS = ['.png','.jpg','.jpeg','.webp','.gif'] as const;
export const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>>;
export const CHAT_FILE_ACCEPT: string; // .fb2.zip replaced by .zip
export interface ComposerFile { id: number; file: File }
export interface RejectedFile { name: string; reason: string }
export function chatFileExtensionOf(name: string): string | undefined;
export function isChatImage(file: File): boolean;
export function validateChatFiles(current: readonly ComposerFile[], incoming: readonly File[]): { accepted: File[]; rejected: RejectedFile[] };
export function normalizePastedFile(file: File, index: number): File;
export function pastedFilesToAdd(data: Pick<DataTransfer,'files'|'types'|'getData'>): { files: File[]; blockText: boolean };
export function canSend(text: string, files: readonly unknown[], streaming: boolean): boolean;
export function restoreFiles(current: ComposerFile[], snapshot: ComposerFile[]): ComposerFile[];
export function toComposerFiles(files: readonly File[]): ComposerFile[];
export function allowedTypesLabel(): string;
```

Rules:
- **`validateChatFiles`** checks each file in this order:
  1. unsupported type: no allowed extension and not an image MIME; the reason lists the allowed types;
  2. empty;
  3. larger than 20 MB;
  4. over the count limit: only 10 files per message.

  Exact duplicates (same name + size + lastModified) are skipped silently.
- **`normalizePastedFile`**: a file whose name has no allowed extension but has an image MIME type becomes `pasted-image-<n><ext>`.
- **`pastedFilesToAdd`**: `blockText` is true when there is no `text/plain`, or when the plain text equals the file names.
- **`restoreFiles`** = `current.length ? current : snapshot`.

## 5. `useFileDropGuard`
- Add window `dragover`/`drop` listeners. When `types` includes 'Files' and the event is `!defaultPrevented`, call `preventDefault`; on `dragover` also set `dropEffect = 'none'`.
- Never call `stopPropagation`. React zones (the composer and the Sources panel) handle the event first and keep 'copy'.

## 6. Components
- **`ComposerFiles`**:
  - `<ul class="composer-files" aria-label="Attached files">`; each chip has a `KindBadge`, a `LocalThumb` for images, a truncated name with `title`, `formatBytes`, and a remove button (`aria-label="Remove <name>"`);
  - after a remove, focus moves to a neighbouring chip or the textarea;
  - rejections are listed with a dismiss button;
  - an `aria-live="polite"` region announces the count.
- **`LocalThumb`**: `createObjectURL` in `useEffect`, `revokeObjectURL` in the cleanup; no `FileReader`.
- **`UserFileList`**:
  - committed (`{treeId,nodeId,files}`): `AttachmentCard folder="files"`, keyed by name;
  - pending (`{pending,unsaved}`): local rows keyed by id, with the status "uploading…" or "not saved".

## 7. Interface changes
- **Types:** `UserFileInfo`, `FileFolder`, `ChainNode.files`, `MessageDone.files`, `MessagePayload`, `MessageUploadErrorCode`, and the widened error code.
- **Client:** `nodeFileUrl`, `userFileUrl`, `buildMessageBody`, `SendMessageInput.files` / `onAccepted`, and a `folder` argument on the getters.
- **Query keys:** a folder segment.
- **Session:** `Pending.files` / `phase`, and `ChatSession.files` / `fileErrors` / `addFiles` / `removeFile` / `dismissFileErrors` / `canSend`.
- **Composer:** the new props.
- No persistence changes.

## 8. Step ordering
1. `types.ts`.
2. `lib/chat-files.ts` + tests.
3. `client.ts` + `client.test.ts`.
4. `queries.ts`, `source-viewer-context.ts`, `AttachmentViewer.tsx`, `AttachmentCard.tsx` (folder param).
5. `useChatSession.ts`.
6. `LocalThumb.tsx`, `ComposerFiles.tsx`, `Composer.tsx`, and the prop wiring in `ChatView.tsx` / `SideChatView.tsx`.
7. `UserFileList.tsx`, `Exchange.tsx`, `ChatThread.tsx`.
8. `use-file-drop-guard.ts` + `App.tsx`.
9. CSS.
10. From the terminal:
    - `pnpm --filter @otago/web format`;
    - `pnpm --filter @otago/web lint` (`biome check . && tsc --noEmit`);
    - `pnpm --filter @otago/web test`;
    - `pnpm --filter @otago/web build`.

    If the filter does not resolve, run the same scripts inside `web/`.
11. Manual smoke test through the Vite proxy.

## 9. Test plan

### 9.1 `lib/chat-files.test.ts`
- **`chatFileExtensionOf`:**
  - `book.FB2.ZIP` → `.fb2.zip`;
  - `a.zip` → undefined;
  - `A.PDF` → `.pdf`;
  - `.png` → undefined;
  - `noext` → undefined.
- **`CHAT_FILE_ACCEPT`:** has `.zip`, not `.fb2.zip`.
- **`validateChatFiles`:**
  - `.docx` is rejected with the allowed list;
  - a 0-byte file → empty;
  - an oversize file → too large;
  - 8 current + 4 incoming → 2 accepted, 2 rejected;
  - a nameless `image/png` → accepted;
  - a nameless pdf → rejected;
  - a duplicate is skipped.
- **`normalizePastedFile`:**
  - `image.png` is kept;
  - `''` + `image/png` → `pasted-image-1.png`;
  - `''` + `text/plain` → unchanged.
- **`pastedFilesToAdd`:**
  - no files → none;
  - image only → blockText true;
  - file + name as text → true;
  - image + real text + html → false.
- **`canSend`:** the 4 cases; `restoreFiles` both branches; `toComposerFiles` ids unique.

### 9.2 `api/client.test.ts` additions (existing tests unchanged)
- `buildMessageBody` with no files: the JSON body and header.
- `buildMessageBody` with files: the keys are `['payload','files','files']`, the payload JSON is correct (text may be `''`), the names are preserved, and there is no content-type.
- `sendMessage` with files: the body is FormData with no content-type; `onAccepted` fires once, before the first chunk; `done.files` is passed through and a missing one defaults to `[]`.
- A 400 `unsupported_file_type` and a 413 `file_too_large` become an `ApiError` with the code kept, and `onAccepted` is not called.
- `userFileUrl` encoding; `attachmentUrl` is unchanged.
- `getChain` defaults `files`; `getAttachmentText(..., 'files')` hits `/files`.

### 9.3 Manual smoke test
1. Picker, chips and remove; the uploading → answering phase; server names after `done`; Preview/Download.
2. A pasted screenshot is added; text paste is unaffected; a Word image + text pastes both.
3. Drop highlight with no flicker; a drop outside does not navigate; the Sources panel drop still works.
4. Client rejections: 11th file, `.docx`, `.zip`, 0-byte, over 20 MB; the Attach button is disabled at 10.
5. Files-only message.
6. A server rejection (corrupt epub): the message is shown, and the text and files are restored; no node.
7. Stop during upload: the draft and files are restored, with no error.
8. Side chat, concurrent sends; a move during an upload shows 409.
9. After reload the files are listed, and a follow-up in the branch works.
10. Same name in both folders: a user `a.png` and an agent `a.png` preview different content.

## 10. Risks
- An early 400/413 during a big upload may surface as a network `TypeError`. Server `drainParts` mitigates it; decide on a client mapping only if the smoke test shows it.
- No upload progress, only the phase label.
- `accept=".zip"` shows all zips in the picker. The same compound-extension bug is latent in `SOURCE_ACCEPT` (out of scope; report it).
- The chain seed must use the server's `done.files`.
- Object URLs live only inside `LocalThumb` effects.
- The query key shape changes (all keys go through `keys.*`).
- Future URL seam: `ComposerItem` union + `payload.urls`, sharing the 10-item limit.
