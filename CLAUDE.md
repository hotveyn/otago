# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Otago is a local-only web app for learning through branching conversations with Claude. Each Q&A exchange is a node in a tree; all state is plain files under `trees/` (no database). See `README.md` for features, `docs/design.md` for file formats and API, `docs/backend-stack.md` for library choices.

## Commands

pnpm 10 + Turborepo monorepo, Node 22+. Packages: `@otago/server` (`server/`), `@otago/web` (`web/`).

| Command (repo root) | What it does |
|---|---|
| `pnpm dev` | Server (`127.0.0.1:3001`, `tsx watch`) + web (`127.0.0.1:5173`, Vite proxies `/api`) |
| `pnpm build` | Build both |
| `pnpm test` | Vitest in both packages |
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
- A node = any folder containing `node.md`. **Node id = path relative to the tree folder** (e.g. `ownership/borrowing-rules`); folder name is the kebab-case display name, unique among siblings (`-2` suffix on collision). Sibling order = `created` frontmatter.
- `node.md` holds one exchange, split by `<!-- otago:user -->` / `<!-- otago:assistant -->` markers (parse/serialize in `server/src/storage/format.ts`).
- Per-node subfolders: `attachments/` (files the agent saved) and `files/` (user uploads). Reserved names are in `server/src/storage/paths.ts`.
- Delete is soft: `parent/<name>` → `parent/<name>.deleted-<epochMs>` (non-slug, so invisible to hierarchy/ids and hidden from the agent). Trash id = path of that folder; `POST /trees/:tree/nodes/restore` renames it back (`-2` if the name was taken).
- E-books/PDFs are converted to `<name>.<ext>.md` on upload (`server/src/storage/ebooks/`) so the agent can Grep them.

### Server (`server/src`)
- `app.ts` `buildApp(deps)` wires Fastify with Zod type provider; all routes under `/api`, each route plugin receives `RouteDeps` (`treesDir`, `agent`, `models`, `locks`, `allowPrivateUrls`). Throw `AppError` subclasses from `errors.ts`; the central error handler maps them to status + `{ error, code?, details? }`.
- `storage/` is the only layer that touches disk. Writes are atomic (temp dir + rename, helpers in `fs-utils.ts`).
- `agent/` wraps `@anthropic-ai/claude-agent-sdk`. `Agent` interface (`types.ts`) has `ask` (async generator of `chunk`/`done` events) and naming. `claude-agent.ts` runs the SDK isolated from user settings/MCP/sessions, with `cwd` = tree folder, read-only tools (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) plus the in-process `save_attachment` MCP tool (`attachment-tool.ts`). The agent never writes files itself; only the server does.
- `agent/lock.ts` `TreeLocks`: per-tree in-memory readers–writer lock. Message streams take shared; move/delete take exclusive. Conflicts return 409 immediately (never queued) with exact messages/codes.
- Message flow (`routes/messages.ts`): acquire shared lock → read chain root→N → create a staging folder next to the future node → validate/stage user files before any SSE byte → stream agent chunks over SSE → on success seal staging and `createNode` renames it into place (atomic); on failure discard. Every request rebuilds context from files; the prompt is built in `agent/prompt.ts`.
- Tests use `test/helpers.ts`: `makeTempDir()` and `fakeAgent()` (scripted chunks, gates, failures, attachment saves) injected into `buildApp` — no real SDK calls in tests.

### Web (`web/src`)
- React 19 + Vite, TanStack Query for server state (`api/queries.ts`, `api/client.ts`), SSE parsing in `api/sse.ts`, React Flow + dagre for the graph (`components/graph/`).
- Navigation state lives in the URL (`lib/url-state.ts`: `?tree=&node=&side=&sideNode=`), synced via `useSyncExternalStore`; tree edits update it through `afterMove`/`afterDelete` in `lib/tree.ts`.
- Pure logic is kept in `lib/*.ts` with colocated `*.test.ts`; components stay thin.
- Tree undo (Ctrl+Z): history lives in `lib/undo-history.ts` (per-tree sessionStorage stack, cap 50), driven by `components/graph/useTreeUndo.ts`; shortcut/focus rules in `lib/keyboard.ts`. `HistoryEntry` is an open discriminated union (`move`, `delete`); add new undoable actions as new members. Every entry holds its own inverse data. After any id-changing response, remap the whole stack by prefix (`old` / `old/…` → `new…`). Undo errors: 409 keeps the entry, 400/404 drop it.

## Feature workflow

New features go through the `/feature:*` skills (describe → research → plan → implement). Per-feature docs, plans and the server-owned shared contract live in `.claude/features/<feature>/`. `tasks/` holds the original v1 roadmap.
