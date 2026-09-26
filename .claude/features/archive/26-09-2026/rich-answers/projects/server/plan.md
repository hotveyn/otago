# Plan — `rich-answers` / project `server`

Stack: Fastify 5 + TypeScript (NodeNext ESM), zod 4, Claude Agent SDK `^0.3.280`, vitest. Root: `server/`.
Contract (owner = this project): `.claude/features/rich-answers/contracts/` (`attachments.ts`, `http.ts`, `sse.ts`, `agent-tool.ts`). Implement strictly to it.

No codegen exists in this repo (no OpenAPI/gRPC). The web mirrors types by hand in `web/src/api/types.ts` (web plan's job). No new npm dependencies are needed (global `fetch`, `node:stream/promises`, `node:dns`, `node:net`).

## 1. Design summary

- **Storage.** `<nodeDir>/attachments/<name>`. No metadata file. `AttachmentInfo` (name, size, contentType, kind) comes from `readdir` + `stat` + an extension table. `origin` only exists in stream events.
- **Staging = the future node folder.** At request start (under the tree lock, `parentId` already known) the route creates `mkdtemp(<parentDir>/.tmp-answer-)`. Files go to `<staging>/attachments/`. On success, `node.md` is written into the staging dir and the whole dir is `rename`d to `<parentDir>/<name>`: one atomic step. On any failure or abort the staging dir is removed with `rm -rf`. It is in the same directory as the target, so the rename never crosses devices. `.tmp-*` is not a slug, so the hierarchy reader already ignores it.
- **Staging API is source-agnostic** (`AnswerStaging.saveFromBytes` / `saveFromStream` / `saveFromUrl`). This leaves a seam for a future sandbox: it can call `saveFromStream(…, origin: 'sandbox')` or drop files and register them. The agent tool is only one producer.
- **Agent wiring.** `AskInput` gains `staging: AttachmentStaging` (an interface). `createClaudeAgent` builds an in-process MCP server `otago` with tool `save_attachment` bound to that staging object. It adds `mcp__otago__save_attachment` to `allowedTools`. `Write`/`Edit`/`Bash`/`NotebookEdit` stay denied. The fake agent in tests calls `input.staging.save…` directly, so integration tests need no SDK.
- **Events.** Staging emits `saving | ready | failed` events through a callback. The route forwards them as SSE `attachment`. `done` becomes `{ nodeId, attachments }`.
- **Reserved name.** `attachments` is reserved at every level: node-name uniqueness, id validation, and the hierarchy reader.

## 2. Files to create

| Path | Purpose |
|---|---|
| `server/src/storage/attachments.ts` | Name sanitizing, kind/MIME table, list/open helpers, `AnswerStaging` implementation |
| `server/src/storage/download.ts` | URL download: SSRF guard, manual redirects, timeouts, filename fallback, streams to a file |
| `server/src/agent/attachment-tool.ts` | `createAttachmentMcpServer(staging)` using `createSdkMcpServer` + `tool()` from the SDK; zod input schema; maps results/errors to `CallToolResult` |
| `server/src/routes/attachments.ts` | `GET /trees/:tree/attachments?node&name[&download=1]` streaming route |
| `server/test/attachments.test.ts` | Unit tests: sanitize, unique suffix, kind/MIME, staging commit/discard, listing |
| `server/test/download.test.ts` | Unit/integration tests for the downloader against a local `http.createServer` |
| `server/test/attachment-tool.test.ts` | Tool handler tests: input validation, result JSON, `isError` paths |
| `server/test/attachments-api.test.ts` | Integration: messages + attachments end-to-end with the fake agent; download route |

## 3. Files to change

### `server/src/storage/paths.ts`
- Add `export const ATTACHMENTS_DIR = 'attachments'` and `export const STAGING_PREFIX = \`${TEMP_PREFIX}answer-\``.
- Add `export const RESERVED_NODE_NAMES = new Set([ATTACHMENTS_DIR])`. It applies at every level.
- `RESERVED_ROOT_NAMES` becomes `new Set([TREE_FILE, SOURCES_DIR, ATTACHMENTS_DIR])`. Add helper `reservedNamesFor(parentId)`, which returns the root set for `''` and `RESERVED_NODE_NAMES` otherwise.
- `nodeIdSegments`: also reject any segment in `RESERVED_NODE_NAMES` (not only the first one).

### `server/src/storage/nodes.ts`
- `readChildren`: skip `RESERVED_NODE_NAMES` at every level (keep the root-only check for `RESERVED_ROOT_NAMES`).
- `ChainNode` gains `attachments: AttachmentInfo[]`. `readChain` fills it via `listAttachments(nodeDir)`.
- `createNode(treeDir, parentId, desiredName, node, options?: { stagingDir?: string })`:
  - use `reservedNamesFor(parentId)` for `uniqueName`;
  - with `stagingDir`: write `node.md` into it, then retry-rename `stagingDir` → `<parentDir>/<uniqueName>` on `EEXIST`/`ENOTEMPTY`. Do not delete the staging dir between retries; the caller discards it on final failure;
  - without `stagingDir`: current `createDirAtomic` path (unchanged behavior).
- `moveNodes`: use `reservedNamesFor(targetParentId)`.

### `server/src/storage/fs-utils.ts`
- Add `uniqueFileName(taken: ReadonlySet<string>, name: string): string`. It puts the suffix before the last extension (`chart.svg` → `chart-2.svg`, `archive.tar.gz` → `archive.tar-2.gz`, `README` → `README-2`). It is synchronous so parallel tool calls can reserve names without races.

### `server/src/storage/sources.ts`
- No behavior change. Optionally move the extension→MIME switch into the shared table in `attachments.ts` and keep `contentTypeOf` for sources as is. Do not change sources' allowed types.

### `server/src/storage/index.ts`
- Export `attachments.js` and `download.js`.

### `server/src/agent/types.ts`
- `AskInput.chain`: `Pick<ChainNode, 'id' | 'user' | 'assistant' | 'attachments'>[]`.
- `AskInput.staging: AttachmentStaging`. The interface is re-exported from storage:
  ```ts
  interface AttachmentStaging {
    saveFromBytes(input: { name: string; data: Uint8Array; origin: AttachmentOrigin }): Promise<AttachmentInfo>;
    saveFromUrl(input: { url: string; name?: string }): Promise<AttachmentInfo>;
    saveFromStream(input: { name: string; stream: Readable; origin: AttachmentOrigin }): Promise<AttachmentInfo>;
  }
  ```
  All three emit `saving`/`ready`/`failed` and throw `AttachmentError` (a message meant for the agent) on failure.
- `AgentEvent` unchanged (attachment events go through staging, not through the agent stream).

### `server/src/agent/claude-agent.ts`
- `buildAskOptions(input, abortController)` now also takes `input.staging`. It sets `mcpServers: { otago: createAttachmentMcpServer(input.staging) }` and `allowedTools: [...ALLOWED_TOOLS, SAVE_ATTACHMENT_TOOL_ID]`. `tools` (built-ins) stays `ALLOWED_TOOLS`, and `strictMcpConfig: true` stays.
- Export `SAVE_ATTACHMENT_TOOL_ID = 'mcp__otago__save_attachment'`.
- Streaming: text handling stays as is. Tool-use blocks are not surfaced as text.
- `name()` still uses `mcpServers: {}` (from `baseOptions`).

### `server/src/agent/prompt.ts`
- Extend `SYSTEM_RULES` with a "Rich output" section (keep the existing six rules; the test for them must still pass):
  - Diagrams: use ```` ```mermaid ```` fenced blocks.
  - Small tables: GFM tables or ```` ```csv ````/```` ```tsv ```` blocks.
  - Files (SVG illustrations, datasets, documents, images): call `save_attachment` with `content`+`encoding` or `url`. Reference the file with the returned `path`: `![alt](attachments/<name>)` for images/SVG, `[label](attachments/<name>)` otherwise. Always use the name returned by the tool.
  - Never put SVG inline in the answer; save it as a `.svg` attachment.
  - Attachments of earlier answers are listed in the transcript and can be read with `Read` at `<node-id>/attachments/<name>`. Do not link to them with `attachments/…` (that prefix means the current answer). Save a new version instead.
  - Replace "Never try to modify files." with "Never try to modify files; the only way to create a file is `save_attachment`."
- `buildUserPrompt`: after each `<assistant>` block of a chain node that has attachments, emit
  `<attachments>\n<node-id>/attachments/<name> (<kind>, <size> bytes)\n…\n</attachments>`. Nodes without attachments produce exactly the current output (keep the existing transcript test green).

### `server/src/routes/messages.ts`
Flow (all under the existing lock):
1. After `readChain`, sweep stale `.tmp-answer-*` dirs in `parentDir` that are older than 1 hour (best effort, errors ignored). Then create the staging with `createAnswerStaging({ parentDir, signal: controller.signal, onEvent })`. If this fails before `hijack`, release the lock and rethrow.
2. `onEvent` → `send('attachment', event)`.
3. Pass `staging` to `agent.ask`.
4. On success: `createNode(..., { stagingDir: staging.dir })`, then `send('done', { nodeId, attachments: await listAttachments(newNodeDir) })`.
5. `finally`: if the node was not committed, `await staging.discard()` (rm -rf, idempotent). The staging object also refuses new saves once discarded or aborted, and in-flight downloads are aborted through `controller.signal`.
6. Staging creation needs `parentDir = nodeDirOf(treeDir, parentId)`. `readChain` already validated it.

### `server/src/app.ts`
- Register `attachmentRoutes`. Add `allowPrivateUrls?: boolean` to `AppDeps`/`RouteDeps` (default `false`). It is threaded into staging for tests.

### `server/src/config.ts` / `server/src/index.ts`
- `Config.allowPrivateUrls = env.OTAGO_ALLOW_PRIVATE_URLS === '1' || === 'true'`, passed to `buildApp`.

### `server/test/helpers.ts`
- `FakeAgentOptions.attachments?: Array<{ at: number; save: (s: AttachmentStaging) => Promise<unknown> }>` runs a staging call before chunk index `at`. Tool errors are caught and ignored, like the real tool does, so the answer continues.
- `makeApp(agent, models, extra?: { allowPrivateUrls?: boolean })`.

### `server/scripts/ask.ts`
- Pass a staging object (temp dir under `os.tmpdir()` is fine for the CLI script, or a no-op that throws "not available") so it still compiles.

## 4. Module details

### `storage/attachments.ts`
- `sanitizeAttachmentName(raw: string, fallback = 'attachment'): string`:
  1. take the basename after the last `/` or `\`;
  2. NFKD, strip diacritics, whitespace → `-`, drop chars outside `[A-Za-z0-9._-]`, collapse `..`+ → `.`, collapse `-`+;
  3. trim leading `.`/`-`/`_` and trailing `.`;
  4. limit to 120 chars, keeping the extension;
  5. return `fallback` (with the original extension if valid) when empty.

  The result must satisfy `ATTACHMENT_NAME_PATTERN`.
- `assertAttachmentName(name)`: pattern + no `..` → `InvalidInputError` (used by the HTTP route).
- `attachmentKindOf(name)`, `attachmentContentTypeOf(name)`: one extension table (see contract kind list). Text-like types (`text/*`, `application/json`, csv `text/csv`, tsv `text/tab-separated-values`) get `; charset=utf-8`. `image/svg+xml` and binary types get no charset. Unknown types → `application/octet-stream`.
- `listAttachments(nodeDir): Promise<AttachmentInfo[]>`: returns `[]` when `attachments/` is missing. Only regular files that pass the name pattern (skips dotfiles/`.part-*`). Sorted by name.
- `attachmentPath(treeDir, nodeId, name)`: `resolveInside(nodeDirOf(treeDir, nodeId), ATTACHMENTS_DIR, name)` after `assertAttachmentName`.
- `createAnswerStaging({ parentDir, signal, onEvent, allowPrivateUrls, download? })` → `AnswerStaging` (`dir`, the `AttachmentStaging` methods, `discard()`, `list()`):
  - Keeps a synchronous `Set<string>` of reserved names. The name is reserved before any await, and released if the save fails.
  - Writes to `<dir>/attachments/.part-<key>` with `fs.createWriteStream` + `stream/promises.pipeline` (never buffers whole URL bodies). Then renames to the final name.
  - `saveFromBytes`: rejects empty data (`Empty content`).
  - The tool layer decodes base64 before calling. Base64 validation: after stripping whitespace, `/^[A-Za-z0-9+/]*={0,2}$/`, length % 4 === 0 (also accept base64url and missing padding? Keep strict + clear error), and the decoded length must be > 0.
  - `key` = `crypto.randomUUID()`.
  - Emits `saving` before any validation that can fail with a user-facing message. That way every `failed` has a preceding `saving`.

### `storage/download.ts`
- `downloadToFile({ url, target, signal, allowPrivate }): Promise<{ suggestedName?: string; contentType?: string }>`:
  - `new URL()`; protocol must be in `URL_DOWNLOAD_POLICY.protocols`.
  - SSRF: `dns.lookup(host, { all: true })`. Reject if any address is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), CGNAT 100.64/10, unique-local fc00::/7, `0.0.0.0`, `::`, or IPv4-mapped equivalents, unless `allowPrivate`. Literal IP hosts are checked directly. The check is repeated on every redirect hop. (DNS-rebinding TOCTOU is accepted for a local app; document it in code.)
  - `fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, headersTimeout]) })`. Follow 301/302/303/307/308 up to 5 hops, then fail with `Too many redirects`.
  - Status ≥ 400 → `HTTP <status>`.
  - Body → `Readable.fromWeb(res.body)` piped to the file, with an idle timer (reset per chunk, abort after `idleTimeoutMs`).
  - Filename: parse `Content-Disposition` (`filename*=UTF-8''…` preferred, then `filename=`), else the last non-empty URL path segment (decoded).
  - Extension fallback from `Content-Type` (small reverse map: png, jpeg, gif, webp, svg+xml, pdf, csv, tsv, plain, json, html) when the final name has no extension.
  - All errors are thrown as `AttachmentError` with a short message.

### `agent/attachment-tool.ts`
- zod raw shape: `name: z.string().max(500).optional()`, `content: z.string().optional()`, `encoding: z.enum(['utf8','base64']).optional()`, `url: z.string().optional()`.
- The handler validates exactly-one-of and "name required with content", decodes, then calls staging.
- Success returns `{ content: [{ type: 'text', text: JSON.stringify(SaveAttachmentResult) }] }`.
- `AttachmentError` (or any error) returns `{ isError: true, content: [{ type: 'text', text: message }] }`. It never throws, so the answer continues.
- The tool description explains inputs, the returned `path`, and referencing rules (short).
- `createSdkMcpServer({ name: 'otago', version: '1.0.0', tools: [saveAttachmentTool], alwaysLoad: true? })`. Use per-tool `alwaysLoad: true` so it is never deferred behind tool search.
- Export the handler factory separately (`createSaveAttachmentHandler(staging)`) so it can be unit-tested without the SDK runtime.

### `routes/attachments.ts`
- Schema: `params: treeParams`, `querystring: z.object({ node: nodeId.min(1), name: z.string().min(1).max(200), download: z.literal('1').optional() })`.
- `existingTreeDir` → `assertNodeExists` → `attachmentPath` → `stat` (404 if missing or not a file) → reply with the headers from `contracts/http.ts` and `fs.createReadStream(path)`.
- `Content-Disposition`: `${download ? 'attachment' : 'inline'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`. Names are ASCII-safe by construction.
- No lock.

## 5. Step ordering

1. `paths.ts` reserved names + `nodes.ts` reader/uniqueness changes + tests (storage.test.ts, nodes-api.test.ts additions).
2. `attachments.ts` (sanitize, kinds, list, path) + unit tests.
3. `fs-utils.ts` `uniqueFileName` + `AnswerStaging` (bytes/stream, events, discard) + unit tests.
4. `createNode` `stagingDir` option + `readChain` attachments + tests.
5. `download.ts` + tests with a local HTTP server (redirect chain, 404, timeout, Content-Disposition, private-address block with `allowPrivate=false`, allowed with `true`).
6. `agent/types.ts`, `attachment-tool.ts`, `claude-agent.ts` wiring + tests (`buildAskOptions` contains the MCP server and the allowed tool id; denied tools unchanged).
7. `prompt.ts` system rules + transcript attachments + tests.
8. `routes/messages.ts` staging lifecycle + `routes/attachments.ts` + `app.ts`/`config.ts`/`index.ts` + `helpers.ts` + integration tests.
9. `scripts/ask.ts` compile fix.
10. Run `pnpm --filter @otago/server lint` (biome check + tsc) and `pnpm --filter @otago/server test`. To format, use `pnpm format` / `biome format --write .` (terminal command, not manual formatting).

## 6. Test plan

**Unit (`attachments.test.ts`)**
- sanitize: `../../etc/passwd` → `passwd`; `a/b\\c.svg` → `c.svg`; `Мой файл.csv` → safe ASCII with `.csv` (fallback `attachment.csv`); spaces → `-`; leading dots stripped; 300-char name trimmed to ≤120 with its extension kept; empty → `attachment`. Every output matches `ATTACHMENT_NAME_PATTERN`.
- `uniqueFileName`: `chart.svg` ×3 → `chart.svg`, `chart-2.svg`, `chart-3.svg`; names without an extension.
- kind/MIME table for each kind; unknown → `other` / `application/octet-stream`.
- `listAttachments`: missing dir → `[]`; skips dotfiles, `.part-*` and subdirectories; sorted.
- Staging: save bytes → file present in `<dir>/attachments`, events `saving`→`ready` with `origin`; empty data → `failed` + thrown `AttachmentError`; parallel saves with the same name get distinct names; `discard()` removes the dir and is idempotent; saves after discard/abort reject; failed stream save leaves no `.part-` file.

**Unit (`download.test.ts`)** with a local `http.createServer` and `allowPrivate: true` except for the SSRF tests:
- 200 body streamed to file; Content-Disposition name preferred; URL path fallback; extension from Content-Type.
- redirects: 3 hops OK; 6 hops → error; relative `Location` resolved.
- 404 → `HTTP 404`; `ftp://` / `file://` → rejected; idle timeout (server stalls) → error (use small timeouts via injectable policy).
- `allowPrivate: false`: `http://127.0.0.1:<port>` and `http://localhost` rejected; redirect from allowed to private rejected (simulate with injectable lookup).

**Unit (`attachment-tool.test.ts`)** on the handler factory with a fake staging:
- utf8 content → result JSON with `path: 'attachments/<name>'`.
- base64 valid → bytes decoded correctly; invalid base64 → `isError`.
- both content+url / neither → `isError`; content without name → `isError`.
- staging throws → `isError`, the handler does not throw.

**Agent (`agent.test.ts` additions)**
- `buildAskOptions` includes `mcpServers.otago` and `SAVE_ATTACHMENT_TOOL_ID` in `allowedTools`; `disallowedTools` still has Write/Edit/Bash/NotebookEdit; `tools` still equals `ALLOWED_TOOLS`.
- System prompt mentions `save_attachment`, `mermaid`, `attachments/`; the existing six-rule test stays green.
- `buildUserPrompt` with an attachment-bearing chain node emits the `<attachments>` block with `<node-id>/attachments/<name>`; without attachments the output is byte-identical to before.

**Integration (`attachments-api.test.ts`, fake agent)**
- Success: the fake agent saves `memory-layout.svg` (utf8) and `pic.png` (base64). SSE order: `attachment saving`/`ready` events interleaved with chunks, then `done { nodeId, attachments: [2 items sorted] }`. Files exist in `<tree>/<node>/attachments/`; `node.md` is unchanged in format; no `.tmp-*` left in the tree.
- Duplicate names in one answer → second becomes `-2`; `done.attachments` has both.
- Tool failure (empty content) → `attachment failed` event, answer still `done`, node has no `attachments/` dir when nothing succeeded.
- Agent fails after saving → `error` event, no node, no `.tmp-*` dir, no attachments anywhere.
- Client disconnect mid-stream (reuse the existing gate/abort test pattern) → no node, staging removed.
- URL save via local HTTP server (`allowPrivateUrls: true` in `makeApp`) → stored with the fallback name; with the default (`false`) → `failed` event, answer continues.
- `GET /chain` returns `attachments` for the new node and `[]` for old nodes (backward compatibility with a hand-written `node.md` fixture).
- Follow-up question under that node: `agent.calls[1].chain[0].attachments` populated.
- `GET /attachments`: 200 with correct Content-Type, Content-Length, `inline` disposition, nosniff and CSP headers; `download=1` → `attachment`; missing file → 404; `name=../node.md` / `name=.hidden` → 400; unknown node → 404; HEAD works.
- Reserved name: a node created with desired name `attachments` (fake `name: 'attachments'`) gets `attachments-2` at root and under a child; `readHierarchy` never lists an `attachments/` folder as a node even if it contains a `node.md`; move into a parent with a colliding name → `-2`.
- Move/delete a node with attachments: files move with it / are removed.
- Lock: node management returns 409 while a message with a pending attachment save is streaming (existing pattern).

## 7. Risks / notes
- **Existing node literally named `attachments`** (created before this feature) becomes invisible to the hierarchy and its id is rejected. Unlikely, since names come from the naming model. Mention it in release notes; no migration planned.
- SDK MCP tool-call timeout: `createSdkMcpServer` is effectively unbounded by default. Downloads rely on our own idle timeout.
- Streaming previews: attachment bytes are not served until `done` (staging is not exposed over HTTP). The UI shows name/size/kind as "ready" during streaming and enables preview after `done`. If live preview is wanted later, add `GET /trees/:tree/messages/staging/...`. Not in scope.
- Stale staging after a crash: swept per request in the parent dir (> 1 h old). Trees under git may want `.tmp-*` in `.gitignore`; out of scope.

## 8. Future-consideration seams (do not implement)
- `AttachmentOrigin` includes `'sandbox'`. `AnswerStaging.saveFromStream` accepts any `Readable` + origin. A sandbox can write into the same staging dir through it, and the commit pipeline does not care who produced the files.
