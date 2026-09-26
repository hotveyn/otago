# Research: chat file attachments — `web`

Stack: React 19.3, Vite 8, TanStack Query 5, TypeScript 7, Biome, Vitest 5 (node environment; there is no jsdom and no Testing Library, so the tests cover pure `lib/*` and `api/*` code only).

## 1. Context: existing patterns this feature must fit

| Area | Where | What exists today |
|---|---|---|
| Composer | `web/src/components/chat/Composer.tsx` | Controlled textarea (`value`/`onChange`), Enter sends, `ComposerHandle.focusEnd` through `useImperativeHandle`, model selects, Send/Stop. It knows nothing about files. Send is gated on `value.trim()` in two places (the `onKeyDown` handler and the Send button's `disabled`). |
| Session state | `web/src/components/chat/useChatSession.ts` | One hook per panel. It owns `draft`, `pending`, `AbortController`, and model choice. `send()` clears the draft and sets `Pending`. On failure it restores the draft with `setDraft(current => current \|\| text)`. On success it seeds the `keys.chain(tree, nodeId)` cache with a synthetic `ChainNode`. |
| Shared panels | `ChatView.tsx`, `SideChatView.tsx` | Both render `<ChatThread>` + `<Composer>` fed by their own `useChatSession`. Anything added to the hook and the Composer props reaches both panels automatically, and the two sessions are fully independent. |
| Transport | `web/src/api/client.ts` `sendMessage`, `api/sse.ts` | JSON `fetch` POST to `/api/trees/:id/messages`, then `readSse(res.body)`. Events handled: `chunk` / `attachment` / `done` / `error`; unknown events are ignored. Errors go through `errorOf` into `ApiError(status, message, code)`. |
| File upload precedent | `api.uploadSource` + `SourcesPanel.tsx` | `FormData` with `form.append('file', file, file.name)`. `request()` sets JSON content-type only for string bodies, so multipart boundaries are already handled correctly. There is a hidden `<input type=file multiple accept={SOURCE_ACCEPT} hidden>` triggered by a `Button`. `event.target.value = ''` lets the same file be picked again. There is a naive drop zone (`dragover` sets `dragging=true`, `dragleave` sets it false, which flickers over children) and a biome-ignore note: "the Upload button is the keyboard path". |
| Allow-list | `web/src/lib/sources.ts` | `EBOOK_EXTENSIONS` (compound `.fb2.zip` is listed first so `endsWith` matching prefers it), `SOURCE_ACCEPT`, `formatLabel`. The server mirrors this in `server/src/storage/sources.ts` (`SOURCE_EXTENSIONS`). `MAX_SOURCE_BYTES = 20 MiB` is in `server/src/app.ts`. |
| Attachment UI | `AttachmentCard.tsx`, `AttachmentList.tsx`, `AttachmentInline.tsx` (`KindBadge`, `BrokenAttachment`), `AttachmentViewer.tsx`, `source-viewer-context.ts`, `lib/attachments.ts` | Built for **agent-generated** files in `<node>/attachments/`. `AttachmentCard` shows a badge, name, size, Preview/Download and an inline image/table preview. URLs are hard-wired to `attachmentUrl(tree, node, name)`. Query keys `keys.attachment(tree, node, name, size)` have no folder dimension. `AttachmentView` = `{treeId, nodeId, attachment}`. `AttachmentInfo`/`AttachmentKind` are the server-computed metadata (`epub`/`fb2`/`mobi` map to `other`, which means Download only). |
| Chain data | `ChainNode.attachments` (types.ts) | Documented as "Files in `<node>/attachments/`". Chain keys are `['chain', tree, node]` and are **not** under `['tree', id]`, so the post-send `invalidateQueries(keys.tree)` does not refetch the seeded chain. Whatever the client seeds is shown until the chain refetches on its own. |
| Errors | `lib/chat-errors.ts`, `ui/ErrorNote.tsx` | `describeError` maps 409/404 codes; any other `ApiError` shows the server message as-is. That is enough for server 400 validation messages. |
| Global drop guard | none | No window-level `dragover`/`drop` handler exists. Dropping a file anywhere outside the Sources panel currently makes the browser navigate to the file. |

Consequence for the design: user-attached files must stay **separate from the agent's `attachments`** in both the data model and the UI:
- a separate chain field, e.g. `files: AttachmentInfo[]`;
- a separate URL, e.g. `/api/trees/:id/files?node=&name=` (or `attachments?…&scope=user`, as the server decides);
- separate query keys.

Otherwise a user file and an agent attachment with the same name would collide in the cache and in `attachments/<name>` link resolution.

## 2. Approaches

### A. Transport

**A1. Multipart `POST /messages` that responds with `text/event-stream` (single request).**
- `fetch(url, { method: 'POST', body: formData, signal })`. The response body streams exactly as it does today, because request-body type and response streaming are independent, so `readSse` is reused unchanged.
- The browser sets `multipart/form-data; boundary=…` itself. Never set `content-type` manually.
- A JSON body is still sent when there are no files, so the existing contract and tests are untouched (backward compatibility).
- Abort: `AbortController` cancels the upload **and** the stream. The server must treat a mid-upload close as "discard staging".
- Upload progress: `fetch` has no upload progress events. Request-body streaming (`duplex: 'half'`) needs HTTP/2 and is not supported over the Vite HTTP/1.1 proxy, so it is not an option. Instead, show a phase: until the response headers arrive, the request is "Uploading / checking files…"; after `res.ok`, it is "Answering…". The server validates before it answers, so this phase boundary is honest.

**A2. Upload first (`POST /uploads` returns staging ids), then JSON `POST /messages { fileIds }`.**
- Gives real per-file progress (with XHR) and allows early per-file server errors.
- Costs: the server needs a staging area with TTL/garbage collection and ownership rules, which is extra state and conflicts with "no DB, bounded, atomic". Orphaned uploads need cleanup when the user removes a chip or closes the tab. It adds a second failure mode plus a race with the tree lock. The client needs upload state per chip (uploading/failed/retry).
- The main benefit (progress for large files) matters little at 10 × 20 MiB on a local-first app.

**A3. Base64 files inside the JSON body.**
- Rejected: about 33 % size overhead, the whole payload is buffered in memory on both sides, it breaks the bounded-memory NFR, and it hits the JSON body limits.

### B. Composer file state location

**B1. Files live in `useChatSession`, next to `draft`.**
- `send()` needs them, failure/abort must restore them just like the draft, and both panels already get the hook. The Composer stays a controlled component: `files`, `onAddFiles`, `onRemoveFile`.

**B2. Files are local state inside `Composer`, passed up in `onSend(files)`.**
- Simpler props, but restoring files after a failed send needs an imperative handle. It also splits one "draft" concept across two owners and breaks the hook's "draft lives here" convention.

**B3. A separate `useComposerFiles()` hook used by the views.**
- Duplicates wiring in `ChatView` and `SideChatView`. It is only worth it if files had to outlive the session, which they do not.

### C. Rendering user files

**C1. Generalize the existing cards over a "file location".**
- Introduce a location/URL builder such as `{ treeId, nodeId, folder: 'attachments' | 'files' }`, or a `urlOf(name, download)` prop.
- Thread it through `AttachmentCard`, `AttachmentView`/`AttachmentViewer`, `useAttachmentText`/`useAttachmentBlob` and their query keys.
- Render a compact list (`<UserFileList>`) under `.msg-user` in `Exchange`.

**C2. A new, simpler `UserFileChip` list (name, size, badge, Download, image thumbnail).**
- No Preview dialog. Less refactoring, but it duplicates the badge/size/preview logic and loses the PDF/text viewer.

## 3. Trade-offs

| | A1 multipart + SSE | A2 upload-first |
|---|---|---|
| Atomic files+node, no staging GC | yes | no (needs TTL staging) |
| SSE path unchanged | yes | yes |
| Upload progress | phase only | per file |
| Abort semantics | one controller | two phases, orphans |
| JSON backward compatibility | yes (JSON when there are no files) | yes |
| Client complexity | low | medium-high |
| Future `urls` field | a `payload` JSON field can carry it | a `urls` field next to `fileIds` |

| | C1 generalize cards | C2 new chip list |
|---|---|---|
| Reuse (Preview dialog, PDF/text/table viewer, KindBadge) | full | partial |
| Refactor surface | `AttachmentCard`, `AttachmentViewer`, context, queries keys | none |
| Risk of cache/name collision | removed by key change | still must key by folder |

## 4. Recommended approach

**A1 + B1 + C1.** Everything should be implemented with pure helpers in `lib/` (unit-tested in Vitest's node environment) and thin React wiring.

### 4.1 Allow-list and validation: new `web/src/lib/chat-files.ts`

- `CHAT_FILE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.png', '.jpg', '.jpeg', '.webp', '.gif']`, reusing `EBOOK_EXTENSIONS` from `lib/sources.ts`. Constants: `MAX_CHAT_FILES = 10`, `MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024`. Mirror them from the server contract with a "mirrors …/contracts" comment, as `types.ts` does.
- `chatFileExtensionOf(name)`: longest-suffix match, so `.fb2.zip` wins over `.zip`, and a plain `x.zip` is rejected.
- `CHAT_FILE_ACCEPT`: **do not put `.fb2.zip` into `accept`**. Chrome and Firefox mishandle compound extensions in `accept` (they reject everything, or even crash; see References). Use `.zip` in `accept` and let `validateChatFiles` reject non-`.fb2.zip` zips with a clear message. The same latent bug exists in `SOURCE_ACCEPT`; mention it to the caller, but it is out of scope.
- `validateChatFiles(current: File[], incoming: File[])` returns `{ accepted: File[]; rejected: { name: string; reason: string }[] }`. Reasons: unsupported type (list the allowed ones), empty (0 bytes), too large (with the size), over the 10-file limit ("only N more can be attached"). Optionally ignore exact duplicates (same name+size+lastModified). Pure and fully testable.
- `normalizePastedFile(file, index)`: clipboard images often arrive as `image.png`, or with an empty name and only `type`. If the name has no allowed extension but the MIME type is an allowed image type, wrap it: `new File([file], \`pasted-${stamp}-${index}.png\`, { type })`. The server still sanitizes and makes names unique, which is authoritative. This step only keeps the client validation and chip labels sensible.

### 4.2 Session: `useChatSession`

- Add state `files: ComposerFile[]`, where `ComposerFile = { id: number; file: File }`. The id comes from a module counter. Do not use the name as a React key, because duplicates and pasted `image.png` repeats are legal.
- Add `fileErrors: {name, reason}[]` and `addFiles(list)` / `removeFile(id)` / `dismissFileErrors()`.
- `canSend = !streaming && (text.trim() !== '' || (ALLOW_EMPTY_TEXT && files.length > 0))`. Keep this in one helper and use it in both places `Composer` gates today. The open question "text optional?" becomes a single constant that must match the server.
- `send()` does the following:
  1. Snapshot the files and put `files: File[]` (plus metadata) into `Pending` so the in-flight user message can show them.
  2. Clear the composer files.
  3. On **error or abort**, restore them, mirroring the draft rule: `setFiles(current => current.length ? current : snapshot)`.
  4. Add a `phase: 'uploading' | 'answering'` to `Pending`, set from a new `onAccepted` callback that `sendMessage` fires after `res.ok`.
- On success, seed the chain cache with `files` from the `done` payload. Ask the server contract to include `files: AttachmentInfo[]` in `done`, next to `attachments`. Because chain keys are not invalidated by `keys.tree`, this is the only way the new message shows its final (sanitized) file names immediately. Fallback: `invalidateQueries({ queryKey: keys.chain(treeId, nodeId) })`.
- Main chat and side chat each have their own hook instance, so concurrent sends with files need no coordination. Server tree-lock 409s already map through `describeError`.

### 4.3 Transport: `sendMessage` in `api/client.ts`

- Extend `SendMessageInput` with `files?: File[]` and `onAccepted?: () => void`.
- No files: the current JSON request, byte-for-byte, so existing tests stay green.
- With files: build a `FormData`. Recommended shape, to be confirmed with the server contract (server is the owner):
  1. The first part is `payload` = JSON string of the exact current body `{ parentId, text, model?, namingModel? }`. The server parses it with the same Zod schema. Adding `urls` later is just another optional field in `payload`, which is the extension point. Put fields **before** file parts, so a streaming multipart parser can validate `parentId`/lock before consuming bytes.
  2. Then one `files` part per file: `form.append('files', file, file.name)`.
- Put the builder in a small exported pure function (`buildMessageBody(input)` returning `{ body, headers }`) so Vitest can assert JSON vs FormData, part order and names. `FormData`/`File` exist in Node ≥ 20.
- Do not set `content-type` for FormData.

### 4.4 Composer UI: `Composer.tsx`, shared by both panels

- **Attach button**:
  - A `Button` (ghost, e.g. "Attach" with a paperclip glyph, `aria-label="Attach files"`) in `.composer-bar`. It calls `input.current?.click()` on a `<input type="file" multiple accept={CHAT_FILE_ACCEPT} hidden>`.
  - `onChange`: copy `[...event.target.files]`, then reset `event.target.value = ''` (the SourcesPanel convention).
  - Disabled while streaming, like the other controls.
- **Paste** (`onPaste` on the textarea):
  - Read `event.clipboardData.files`. If it is empty, return and let text paste proceed untouched.
  - If there are files, `addFiles([...files].map(normalizePastedFile))`.
  - Call `preventDefault()` only when there is **no** `text/plain` in `clipboardData.types`, or when the plain text is just the file name(s). Some platforms put the file name into `text/plain` when a file is copied in Finder or Explorer. Office/browser "copy image" puts `text/html` plus an image, and there the text must still paste normally.
  - Put this decision in a pure helper in `lib/chat-files.ts` so it is testable.
- **Drag and drop**:
  - Handlers go on the `.composer` root, with a class `composer-drop` for the highlight (reuse the `.panel-drop` look).
  - Use an enter/leave **depth counter** (`useRef<number>`): `dragenter` does `++`, `dragleave` does `--`, the highlight is shown while the counter is > 0, and `drop`/`dragend` resets it to 0. This avoids the flicker the SourcesPanel has when crossing child elements.
  - Only react when `event.dataTransfer.types.includes('Files')`. Text drags into the textarea must keep working.
  - `dragover` must call `preventDefault()` (otherwise `drop` never fires) and set `dropEffect = 'copy'`, or `'none'` while streaming.
- **Window guard**:
  - Add a tiny `useFileDropGuard()` in `App.tsx`: window `dragover` + `drop` listeners that `preventDefault()` when `types` includes `'Files'`, and set `dropEffect = 'none'` if the event was not already handled (`!event.defaultPrevented`).
  - React handlers run before a window bubble listener, so the composer and SourcesPanel zones are unaffected. This fixes "dropping outside the composer navigates the browser" app-wide.
- **Chips**:
  - A `<ul className="composer-files">` above the textarea. Each chip has a `KindBadge` (reused, it works on the name), the name (truncate + `title`), `formatBytes(size)`, and a remove `×` button with `aria-label={\`Remove ${name}\`}`.
  - After a removal, move focus to the next chip's remove button, or to the textarea.
  - Image chips show a thumbnail through a small `<LocalThumb file>` component. It creates the object URL **inside `useEffect`** and revokes it in the cleanup. This is safe under StrictMode double-invocation and handles removal and unmount. Do not use `useMemo`, which leaks when StrictMode re-runs.
  - Never read files with `FileReader`, which keeps memory bounded.
- **Errors**:
  - Per-file rejections are rendered under the chips as an `ErrorNote`-style list, e.g. "book.docx: unsupported type (allowed: …)".
  - They live in a `role="status" aria-live="polite"` region, and the same region announces "3 files attached" / "file removed".
  - Server 400s still arrive as the pending exchange's `ErrorNote` via `describeError`. The files are restored to the composer, so the user can fix the problem and resend.
- **A11y**: the attach button is the keyboard path. The drop zone is a pointer enhancement: add `aria-describedby` on the textarea pointing at a visually hidden hint ("You can also paste or drop files"), and keep the existing biome-ignore justification pattern for the static element with drag handlers.

### 4.5 Rendering files in the user message: `Exchange` / `ChatThread`

- `types.ts`: add `ChainNode.files: AttachmentInfo[]`, defaulted to `[]` in `api.getChain` like `attachments`, for older servers. Add a `fileUrl(tree, node, name, download)` recipe matching the server route.
- Generalize the card by introducing `type FileFolder = 'attachments' | 'files'`. Changes:
  - `AttachmentCard`, `TablePreview`, `AttachmentView` (and `AttachmentViewer`) get an optional `folder` that defaults to `'attachments'`.
  - `api.getAttachmentText`/`getAttachmentBlob` choose the URL by folder.
  - `keys.attachment`/`attachmentBlob` gain the folder segment.
  - The default keeps every existing call site unchanged.
- `Exchange` gets a `files` prop. Under `.msg-user` it renders `<UserFileList treeId nodeId files />`, a compact `<ul>` of `AttachmentCard folder="files">`. The user message does **not** use `AttachmentScope`, so `attachments/<name>` links in the answer keep resolving only against agent attachments.
- Pending exchange: render the local `File`s (name, size, badge, `LocalThumb` for images, and a phase label). On success, the seeded chain entry replaces them with committed `AttachmentInfo` from `done.files`.

### 4.6 Future: attach from URL

- Keep an internal union, `ComposerItem = { kind: 'file'; id; file } | { kind: 'url'; id; url }`, or at least name things so a URL item can be added.
- The chip list, the 10-item cap and `validate*` then work unchanged, and `buildMessageBody` would put `urls` into the `payload` JSON.

### 4.7 Tests (Vitest, node)

- `lib/chat-files.test.ts`:
  - extension matching (compound, case, `.zip` rejected, no extension);
  - size, empty and count limits;
  - pasted-name normalization;
  - the paste decision helper.
- `api/client.test.ts`: the JSON path is unchanged when there are no files; with files, a FormData body with `payload` first and `files` parts, and no content-type header; `onAccepted` fires on `res.ok`; abort rejects.
- Optionally `useChatSession` restore semantics, extracted into pure reducers (e.g. `restoreFiles(current, snapshot)`).

## 5. Risks and pitfalls

- **Contract dependency.** Several details are server-owned and must be pinned in the contract before planning: the multipart field names/order, the `payload` JSON vs flat fields choice, `done.files`, the chain field name, the file URL route, and the empty-text rule. The web plan must follow the server contract.
- **`accept` with compound extensions** breaks pickers (see References). Use `.zip` plus client validation. The picker may then show every `.zip`, which is acceptable.
- **No upload progress with `fetch`.** Uploading 200 MiB over a slow link shows only "Uploading…". Acceptable for now; XHR could be swapped in later without contract changes, because XHR's `onprogress` plus a manual SSE parse of `responseText` works but is clunkier.
- **Stop during upload.** The abort must also discard server staging (a server concern). The client restores the draft and files, and then shows no error, as it does today for aborts.
- **Paste heuristics.** Clipboard contents differ by OS and browser: Finder file copy may include the file name as text, and Office pastes an image alongside text. Keep the logic in one tested helper. Never block text-only paste.
- **Drop guard vs SourcesPanel.** The window listener must not stop propagation and must respect `defaultPrevented`. The SourcesPanel drop zone keeps working.
- **Object URL leaks.** Create and revoke in the same effect. Revoke on remove, on send (when files move to pending, the pending view creates its own URLs) and on unmount.
- **Name/cache collisions.** User files and agent attachments with the same name need distinct URLs and query keys (the folder segment). Also keep user files out of `AttachmentScope`.
- **Chain cache staleness.** Chain keys are not invalidated by `keys.tree`. Without `done.files`, the just-sent message would show no files until the next refetch.
- **Filename display.** The server may rename files (sanitize or dedupe). The UI must show the server's `AttachmentInfo.name` after commit, not the local name.
- **Disabled textarea.** While streaming the textarea is disabled, so paste cannot fire there. The drop zone must ignore drops (`dropEffect: 'none'`) rather than queue files, or else the behaviour of "staging for the next message" must be defined explicitly.

## 6. References

- MDN, `<input type="file">` / `accept`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/accept
- Chromium issue, `accept=".tar.gz"` accepts nothing / crash: https://issues.chromium.org/issues/41195494 and https://groups.google.com/a/chromium.org/g/chromium-dev/c/wYdQCuaRCas
- Mozilla bug 1195508, same for Firefox: https://bugzilla.mozilla.org/show_bug.cgi?id=1195508
- MDN, ClipboardEvent.clipboardData / DataTransfer.files / types: https://developer.mozilla.org/en-US/docs/Web/API/ClipboardEvent/clipboardData
- MDN, HTML Drag and Drop API (dragover must preventDefault; `dropEffect`): https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API
- MDN, `URL.createObjectURL` / `revokeObjectURL`: https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static
- MDN, Using FormData objects (do not set the content-type header): https://developer.mozilla.org/en-US/docs/Web/API/FormData/Using_FormData_Objects
- Chrome, streaming requests with fetch (`duplex: 'half'`, HTTP/2 only), why it is not used for progress: https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests
- Existing code: `web/src/components/sidebar/SourcesPanel.tsx` (upload/drop precedent), `web/src/api/client.ts` (`uploadSource`, `sendMessage`), `web/src/components/chat/AttachmentCard.tsx`.
