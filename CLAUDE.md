# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Otago is a local-only web app for learning through branching conversations with Claude. Each Q&A exchange is a node in a tree; all state is plain files under `trees/` (no database). See `README.md` for features, `docs/design.md` for file formats and API, `docs/backend-stack.md` for library choices.

## Commands

pnpm 10 + Turborepo monorepo, Node 22+. Packages: `@otago/server` (`server/`), `@otago/web` (`web/`), `@otago/demo` (`demo/`).

| Command (repo root) | What it does |
|---|---|
| `pnpm dev` | Server (`127.0.0.1:3001`, `tsx watch`) + web (`127.0.0.1:5173`, Vite proxies `/api`) |
| `pnpm demo` | Browser-only demo (`127.0.0.1:5174`, mock backend, no server) |
| `pnpm build` | Build all packages |
| `pnpm test` | Vitest in all packages |
| `pnpm lint` | `biome check` + `tsc --noEmit` per package |
| `pnpm format` / `pnpm check` | Biome format / Biome check with auto-fix |

Single package / single test:

```bash
pnpm --filter @otago/server test -- test/nodes-api.test.ts
pnpm --filter @otago/web test -- src/lib/url-state.test.ts
pnpm --filter @otago/server test -- -t "test name substring"
```

Ask a question from the terminal without the UI (writes nothing): `pnpm --filter @otago/server ask <tree> "question" [parentNodeId]`.

Formatting: never hand-format code. Run `pnpm format` or `pnpm check` (Biome: 2-space, single quotes, trailing commas, width 100, organized imports).

Config lives in `server/.env` (`OTAGO_TREES_DIR`, `OTAGO_PORT`, `OTAGO_MODEL`, `OTAGO_NAMING_MODEL`, `OTAGO_MODELS`, `OTAGO_ALLOW_PRIVATE_URLS`) and `web/.env` (`OTAGO_API_URL`). Turbo passes `OTAGO_*` through.

## Architecture

### Filesystem is the source of truth
- A tree = folder under `OTAGO_TREES_DIR` with `tree.md` (frontmatter title + body = tree instructions appended to the system prompt) and `sources/`.
- A node = any folder containing `node.md`. **Node id = path relative to the tree folder** (e.g. `ownership/borrowing-rules`); folder name is the display name, unique among siblings (`-2` suffix on collision). Sibling order = `created` frontmatter.
- Node names are Unicode (`server/src/storage/node-names.ts`): words of letters/marks/digits joined by `-`, lowercase, NFC, ≤ 60 code points / 100 UTF-8 bytes (`toNodeName` is the one sanitizer; `isNodeName` validates). Collisions and reserved names compare by `nameKey` (APFS-like fold: `straße` = `strasse`). Route schemas normalize every node id/trash id/name to NFC. Tree ids stay ASCII (`isTreeId`/`toTreeId` in `paths.ts`).
- `node.md` holds one exchange, split by `<!-- otago:user -->` / `<!-- otago:assistant -->` markers (parse/serialize in `server/src/storage/format.ts`).
- Per-node subfolders: `attachments/` (files the agent saved) and `files/` (user uploads). Reserved names are in `server/src/storage/paths.ts`.
- Delete is soft: `parent/<name>` → `parent/<name>.deleted-<epochMs>` (non-slug, so invisible to hierarchy/ids and hidden from the agent). Trash id = path of that folder; `POST /trees/:tree/nodes/restore` renames it back (`-2` if the name was taken).
- E-books/PDFs are converted to `<name>.<ext>.md` on upload (`server/src/storage/ebooks/`) so the agent can Grep them.

### Server (`server/src`)
- `app.ts` `buildApp(deps)` wires Fastify with Zod type provider; all routes under `/api`, each route plugin receives `RouteDeps` (`treesDir`, `agent`, `models`, `locks`, `allowPrivateUrls`, `questions`). Throw `AppError` subclasses from `errors.ts`; the central error handler maps them to status + `{ error, code?, details? }` and fills `details` of every 409 `tree_busy_streaming` (`TreeBusyError`) with the blocking questions.
- `storage/` is the only layer that touches disk. Writes are atomic (temp dir + rename, helpers in `fs-utils.ts`).
- `agent/` wraps `@anthropic-ai/claude-agent-sdk`. `Agent` interface (`types.ts`) has `ask` (async generator of `chunk`/`done` events) and naming. `claude-agent.ts` runs the SDK isolated from user settings/MCP/sessions, with `cwd` = tree folder, read-only tools (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) plus the in-process `save_attachment` MCP tool (`attachment-tool.ts`). The agent never writes files itself; only the server does.
- `agent/lock.ts` `TreeLocks`: per-tree in-memory readers–writer lock. Questions take shared (holder id = question id, so 409s can name blockers); move/delete/restore/rename and tree title changes take exclusive. Conflicts throw `TreeBusyError` (409) immediately (never queued) with exact messages/codes.
- Questions (`questions/`, contract in `.claude/features/archive/05-10-2026/parallel-questions/contracts/`): `POST /trees/:tree/questions` (`routes/questions.ts`) validates, takes the shared lock, reads the chain, stages files in a `.tmp-answer-*` folder next to the future node, registers the question and replies 202. From then on the client connection is irrelevant: `runner.ts` streams the agent into the in-memory `registry.ts` (events + retention, no I/O), seals attachments, names the node from question + answer (`agent/prompt.ts` `buildNamingPrompt`), then `createNode` renames the staging folder into place. `service.ts` (`Questions`) is the facade routes use: start, cancel/dismiss (`DELETE /questions/:id`), retry (`POST /questions/:id/retry`), shutdown. One app-wide SSE stream (`GET /questions/events`, `routes/sse.ts`) sends a snapshot then deltas (`question`/`chunk`/`attachment`/`removed`). Failed questions keep their user files outside `trees/` (`storage/held-files.ts`, OS temp dir) until retried or dismissed; done entries are kept 30 min, failed 24 h. Structural routes call `questions.remap`/`dropUnder`/`renameTree` for retained entries. The agent's PreToolUse guard (`agent/trash-guard.ts`) hides trash and other answers' `.tmp-*` folders. Every request rebuilds context from files.
- Tests use `test/helpers.ts`: `makeTempDir()`, `fakeAgent()` (scripted chunks, gates raced with abort, failures, attachment saves, `nameGate`/`nameError`) and `makeApp()` (injects a `Questions` with a temp held dir; returns `questions`, `events` recorder, `heldDir`). `askAndSettle(ctx, body)` posts and waits for `ctx.questions.settled(id)`; stream tests use `listen` + `openEventStream`. No real SDK calls in tests.

### Web (`web/src`)
- React 19 + Vite, TanStack Query for server state (`api/queries.ts`, `api/client.ts`), SSE parsing in `api/sse.ts`, React Flow + dagre for the graph (`components/graph/`).
- In-flight questions (contract `.claude/features/archive/05-10-2026/parallel-questions/contracts/`): ONE app-wide SSE per tab, a `fetch` + `readSse` reconnect loop in `api/question-events.ts` (snapshot first, 45 s watchdog on pings, backoff with jitter, reconnect on chunk gaps); `lib/question-sync.ts` wires it to the store, disconnects tabs hidden > 30 s and resyncs on visible/online. State is a pure reducer + selectors in `lib/questions.ts` (SSE copies always replace; 202 copies only insert unknown ids or a higher `attempt`; removed ids are tombstoned), held by `lib/question-store.ts` (created once in `main.tsx`, outside React). The store publishes to React at most once per animation frame (`getSnapshot`), while lifecycle listeners read `getState()` synchronously. Every hook goes through `useStoreSelector` + `createCachedSelector` (stable references are required by `useSyncExternalStore`). The graph never subscribes to stream text; only the focused panels do (`useQuestionView`).
- Chat panels = composer + focus: `components/chat/useComposer.ts` (draft, files, models; sends via `store.ask`, gets the draft back if the send fails before its 202; drafts survive remounts in `lib/draft-stash.ts`) and `useInFlight.ts` (the panel's focused question or its newest send, Cancel/Retry/Dismiss). `components/QuestionEffects.tsx` handles lifecycle side effects (focus a just-accepted question, refresh the tree and follow a saved one, notices via `lib/notices.ts`).
- Navigation state lives in the URL (`lib/url-state.ts`: `?tree=&node=&q=&side=&sideNode=&sideQ=`; ids read from the URL are normalized to NFC), synced via `useSyncExternalStore`; tree edits update it through `afterMove`/`afterDelete` in `lib/tree.ts`. `q`/`sideQ` = the in-flight question a panel shows; `lib/question-focus.ts` `reconcileFocus` keeps them consistent with the store (drop unknown, follow remapped parents, follow a saved answer to its node). Async handlers always read the live URL (`readUrlState(location.search)`).
- Pending boxes: `layoutTree(title, nodes, ghostParent, pending)` places them after a parent's real children (`__q__:<key>` flow ids; the key is the outbox id for this tab's sends, so a box keeps its identity across the 202). Relayout happens on add/remove/remap/label only, never on chunks or status changes. A 409 `tree_busy_streaming` (its `details` list the blockers, read with `lib/blockers.ts`) opens `components/graph/BlockersDialog.tsx` via `BlockersContext`, with the refused action offered again.
- Pure logic is kept in `lib/*.ts` with colocated `*.test.ts`; components stay thin.
- Tree undo (Ctrl+Z): history lives in `lib/undo-history.ts` (per-tree sessionStorage stack, cap 50), driven by `components/graph/useTreeUndo.ts`; shortcut/focus rules in `lib/keyboard.ts`. `HistoryEntry` is an open discriminated union (`move`, `delete`); add new undoable actions as new members. Every entry holds its own inverse data. After any id-changing response, remap the whole stack by prefix (`old` / `old/…` → `new…`). Undo errors: 409 keeps the entry, 400/404 drop it. While answers run (`busy`), Ctrl+Z and a busy 409 open the blockers dialog (`onBusy`) instead of the toast.
- Display text is cut by graphemes (`lib/text.ts`, `Intl.Segmenter`), never with `slice`; node ids are shown with `components/ui/IdPath.tsx` (`<bdi>` per segment) and labels with `dir="auto"`.

### Demo (`demo/src`)
- Static build of the web UI with an in-browser mock backend (Vercel, `demo/vercel.json`). The Vite plugin in `demo/vite.config.ts` redirects every import of `web/src/api/client.ts` to `demo/src/mock/client.ts` (except imports from `demo/src/mock/` itself), so `web/` needs no changes. The shim must export everything the real client exports (`exportsComplete` type guard).
- `mock/vfs.ts`: in-memory FS saved to localStorage (`otago-demo:vfs:v1`) after every `transaction()`, rolled back on error or a full storage (413). `mock/trees.ts` mirrors `server/src/storage/` on it; `mock/questions.ts` simulates the questions registry/runner (Lorem ipsum chunks, naming, commit, cancel/retry, remaps); `mock/connection.ts` feeds the store instead of SSE; `mock/demo.ts` composes them into the `api` object with route semantics (locks, 409s). Node names come straight from `server/src/storage/node-names.ts` (keep it and `server/src/text.ts` free of Node APIs).
- Seed trees are real tree folders in `demo/seed/`, bundled with `import.meta.glob` (`mock/seed.ts`). When the server contract changes, update the mock to match.

## Feature workflow

New features go through the `/feature:*` skills (describe → research → plan → implement). Per-feature docs, plans and the server-owned shared contract live in `.claude/features/<feature>/`. `tasks/` holds the original v1 roadmap.
