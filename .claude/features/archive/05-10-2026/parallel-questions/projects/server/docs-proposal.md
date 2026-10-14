# parallel-questions — proposed doc changes (server plan step 9)

Not applied. The implementer must not edit the root `README.md` / `CLAUDE.md`; the developer
reviews and applies these hunks by hand (or asks for them to be applied). Line numbers refer to
the files at commit `5c56186`. Wording follows the existing style (Biome does not format
Markdown, so no formatter run is needed).

Land these together with the web change (the web still calls `POST /messages` until then).

---

## `README.md`

### Features (after the "Branching chats" bullet, line 23)

```diff
 - **Branching chats.** Each question and answer is a node. Ask a follow-up from any node to start a new branch.
+- **Parallel questions.** Ask several questions at once, in one tree or many. Each one shows up as a pending node in the graph while Claude answers. Answers keep running in the background: reload the page or close the tab and come back later, the answer continues and the node appears when it is done. Cancel a running question, or retry a failed one (its attached files are kept).
 - **Graph view.** Pan, zoom and click around the tree. Drag a node onto another node to move it.
```

### Features: node names (new bullet after "Tree instructions", line 26)

```diff
 - **Tree instructions.** Give each tree its own rules, e.g. *"Answer in Russian. Compare with C++."*
+- **Names in your language.** A new node is named after the question *and* the answer, in the answer's language (`правила-заимствования`, `regeln-der-ausleihe`). Folder names may contain letters of any script; tree folder names stay ASCII.
```

### How it works (lines 64-70)

```diff
-When you send a message at node `N`:
+When you ask a question at node `N`:
 
 1. The server reads the chain `root → … → N` from disk.
 2. It builds the prompt: system prompt + tree instructions + the chain + your message.
 3. The Agent SDK runs inside the tree folder. It can read files but can't write them.
-4. The answer streams to the browser over SSE.
-5. On success, the server writes a new child node atomically. Haiku gives it a short kebab-case name.
+4. The server registers the question and replies `202` right away. The answer streams to every open tab over one app-wide event stream (`GET /api/questions/events`, SSE); a reconnecting tab gets a snapshot of everything in flight.
+5. When the answer is complete, Haiku names the node from the question and the answer, in the answer's language. The server then writes the new child node atomically. A failed answer writes nothing.
```

### Scope and safety (line 159; already outdated by the trash feature)

```diff
-- Deleting a node is permanent. Commit `trees/` to git if you want history.
+- Deleting a node is soft (see Node management) and can be undone. Commit `trees/` to git if you want history.
+- Questions in flight live in server memory only: restarting the server loses running and failed questions (nothing half-written stays in `trees/`).
```

---

## `CLAUDE.md`

### Filesystem is the source of truth (line 37)

```diff
-- A node = any folder containing `node.md`. **Node id = path relative to the tree folder** (e.g. `ownership/borrowing-rules`); folder name is the kebab-case display name, unique among siblings (`-2` suffix on collision). Sibling order = `created` frontmatter.
+- A node = any folder containing `node.md`. **Node id = path relative to the tree folder** (e.g. `ownership/borrowing-rules`); folder name is the display name, unique among siblings (`-2` suffix on collision). Sibling order = `created` frontmatter.
+- Node names are Unicode (`server/src/storage/node-names.ts`): words of letters/marks/digits joined by `-`, lowercase, NFC, ≤ 60 code points / 100 UTF-8 bytes (`toNodeName` is the one sanitizer; `isNodeName` validates). Collisions and reserved names compare by `nameKey` (APFS-like fold: `straße` = `strasse`). Route schemas normalize every node id/trash id/name to NFC. Tree ids stay ASCII (`isTreeId`/`toTreeId` in `paths.ts`).
```

### Server (lines 44-49)

```diff
-- `app.ts` `buildApp(deps)` wires Fastify with Zod type provider; all routes under `/api`, each route plugin receives `RouteDeps` (`treesDir`, `agent`, `models`, `locks`, `allowPrivateUrls`). Throw `AppError` subclasses from `errors.ts`; the central error handler maps them to status + `{ error, code?, details? }`.
+- `app.ts` `buildApp(deps)` wires Fastify with Zod type provider; all routes under `/api`, each route plugin receives `RouteDeps` (`treesDir`, `agent`, `models`, `locks`, `allowPrivateUrls`, `questions`). Throw `AppError` subclasses from `errors.ts`; the central error handler maps them to status + `{ error, code?, details? }` and fills `details` of every 409 `tree_busy_streaming` (`TreeBusyError`) with the blocking questions.
@@
-- `agent/lock.ts` `TreeLocks`: per-tree in-memory readers–writer lock. Message streams take shared; move/delete take exclusive. Conflicts return 409 immediately (never queued) with exact messages/codes.
-- Message flow (`routes/messages.ts`): acquire shared lock → read chain root→N → create a staging folder next to the future node → validate/stage user files before any SSE byte → stream agent chunks over SSE → on success seal staging and `createNode` renames it into place (atomic); on failure discard. Every request rebuilds context from files; the prompt is built in `agent/prompt.ts`.
-- Tests use `test/helpers.ts`: `makeTempDir()` and `fakeAgent()` (scripted chunks, gates, failures, attachment saves) injected into `buildApp` — no real SDK calls in tests.
+- `agent/lock.ts` `TreeLocks`: per-tree in-memory readers–writer lock. Questions take shared (holder id = question id, so 409s can name blockers); move/delete/restore/rename and tree title changes take exclusive. Conflicts throw `TreeBusyError` (409) immediately (never queued) with exact messages/codes.
+- Questions (`questions/`, contract in `.claude/features/parallel-questions/contracts/`): `POST /trees/:tree/questions` (`routes/questions.ts`) validates, takes the shared lock, reads the chain, stages files in a `.tmp-answer-*` folder next to the future node, registers the question and replies 202. From then on the client connection is irrelevant: `runner.ts` streams the agent into the in-memory `registry.ts` (events + retention, no I/O), seals attachments, names the node from question + answer (`agent/prompt.ts` `buildNamingPrompt`), then `createNode` renames the staging folder into place. `service.ts` (`Questions`) is the facade routes use: start, cancel/dismiss (`DELETE /questions/:id`), retry (`POST /questions/:id/retry`), shutdown. One app-wide SSE stream (`GET /questions/events`, `routes/sse.ts`) sends a snapshot then deltas (`question`/`chunk`/`attachment`/`removed`). Failed questions keep their user files outside `trees/` (`storage/held-files.ts`, OS temp dir) until retried or dismissed; done entries are kept 30 min, failed 24 h. Structural routes call `questions.remap`/`dropUnder`/`renameTree` for retained entries. The agent's PreToolUse guard (`agent/trash-guard.ts`) hides trash and other answers' `.tmp-*` folders. Every request rebuilds context from files.
+- Tests use `test/helpers.ts`: `makeTempDir()`, `fakeAgent()` (scripted chunks, gates raced with abort, failures, attachment saves, `nameGate`/`nameError`) and `makeApp()` (injects a `Questions` with a temp held dir; returns `questions`, `events` recorder, `heldDir`). `askAndSettle(ctx, body)` posts and waits for `ctx.questions.settled(id)`; stream tests use `listen` + `openEventStream`. No real SDK calls in tests.
```

### Web (line 52) — only if the web plan does not already update it

The web stage owns this line (`api/sse.ts` → the question event loop). Not proposed here.

---

## Other docs

- `docs/design.md` / `docs/backend-stack.md` are referenced from the README but are not in the
  repository at this commit, so there is nothing to update there.
- `server/.env.example`: no new variables (all question timings are constructor options only).
