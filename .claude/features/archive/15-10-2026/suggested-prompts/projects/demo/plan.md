# Demo plan: suggested-prompts

Project: `demo` (`@otago/demo`, Vite + Vitest, browser-only mock backend). Role: client of the
server-owned contract in `.claude/features/suggested-prompts/contracts/` (read-only here).
No research file. This plan is based on `demo/src/mock/*`, `demo/seed/`, the contract and
`projects/server/plan.md`.

Scope: everything under `demo/` only. The web planner owns all UI and `web/src/api/client.ts` /
`web/src/api/types.ts`. The demo imports the pure server module
`server/src/storage/suggestions.ts` (planned Node-free by the server, like `node-names.ts`) so
the algorithms (sanitize, parse, splice, resolve, candidates, finalize) are identical, not ported.

## Design summary

- **Storage** (`mock/format.ts`, `mock/trees.ts`): `NodeFile.suggestions?: StoredSuggestion[]`.
  The flat frontmatter parser keeps the raw value of the `suggestions:` line and turns it into a
  list with `JSON.parse` + `parseStoredSuggestions` (absent / not JSON / not an array → missing).
  Writers never build the line by hand: new nodes use `setSuggestionsLine(serializedWithout, items)`,
  later writes splice the raw file with `setSuggestionsLine(raw, items)`. A file without the key
  serializes byte-identically to today.
- **Read path** (`TreeStore.suggestionsView`): chain of `{ id, suggestions? }` + used keys of the
  live children of every chain node → `resolveSuggestions` → `SuggestionsResponse`. `chain()`
  strips `suggestions`, so the `ChainNode` wire shape stays unchanged.
- **Generation** (new `mock/suggestions.ts`, class `Suggestions`): a simulated generator
  (template questions + keeping inheritance candidates, sometimes an empty list) behind an
  injectable hook. It covers the lazy path (`ensure`) with an in-memory dedup map, the at-save path
  (`forAnswer` → `peek`/`adopt`/`abort`) and the verified write. No tree lock is taken anywhere.
- **Questions** (`mock/questions.ts`): at `naming` the runner starts a generation in parallel
  with the simulated naming delay. At commit the node is created with the list if it is ready,
  otherwise without it, and the still-running generation is adopted and written later. Cancel or
  failure before commit aborts it. Question statuses and events do not change.
- **Routes** (`mock/demo.ts`): `api.getSuggestions` / `api.generateSuggestions` with the server's
  validation order and status codes (400 / 404 / 502, never 409). The shim (`mock/client.ts`)
  needs no new top-level exports unless the web adds some (see "Expected web client exports").

## Expected web client exports (to reconcile with the web plan)

Derived from contract `suggestions-api.ts` ("the demo shim must export the same names as
`web/src/api/client.ts`") and from the existing pattern where every route is a method of `api`:

| Where | Expected export | Demo side |
|---|---|---|
| `web/src/api/client.ts` `api` | `getSuggestions(treeId: string, node: string): Promise<SuggestionsResponse>` (GET `/trees/:tree/suggestions?node=`) | `api.getSuggestions` in `mock/demo.ts`. Typed by `DemoApi = typeof realApi`, so `tsc` fails until it exists. |
| `web/src/api/client.ts` `api` | `generateSuggestions(treeId: string, node: string): Promise<SuggestionsReady>` (POST `{ node }`) | `api.generateSuggestions` in `mock/demo.ts`. |
| `web/src/api/client.ts` | `ApiErrorCode` includes `'suggestions_failed'` (a new `SuggestionErrorCode` in `types.ts`, also added to the `isErrorCode` code lists and to `ErrorBody.code`) | `suggestionsFailed()` in `mock/errors.ts` builds `new ApiError(502, …, 'suggestions_failed')`. It does not compile without this. |
| `web/src/api/types.ts` | `Suggestion`, `SuggestionsReady`, `SuggestionsMissing`, `SuggestionsResponse`, `SuggestionErrorCode` (hand mirrors of the contract) | Imported as types by `mock/demo.ts`, `mock/trees.ts` and `mock/suggestions.ts`. |
| `web/src/api/client.ts` | **No new top-level value exports expected.** | If the web adds any (for example a URL helper or a code list), `mock/client.ts` must re-export or implement it. The `exportsComplete` guard reports it at `pnpm --filter @otago/demo lint`. |

If the web gives either method an optional `signal?: AbortSignal` (TanStack Query passes one),
the mock accepts it. GET ignores it, because the work is synchronous. POST never aborts on it:
the contract says the generation keeps running and is persisted after a client disconnect.
Response bodies are the contract objects as they are (no `{ suggestions: … }` envelope). The
mock returns `SuggestionsResponse` / `SuggestionsReady` directly.

## Files

### New

| Path | Purpose |
|---|---|
| `demo/src/mock/suggestions.ts` | `class Suggestions`: the mock of `server/src/suggestions/service.ts` (lazy `ensure`, `view`, at-save `forAnswer`, dedup, verified write, outcome → error mapping). It also holds the default simulator `simulateSuggestions(random)` and the `SuggestSimulator` hook type. |
| `demo/src/mock/suggestions.test.ts` | Service + route semantics through `demo.api` (GET/POST, dedup, failures, structural edits during generation, storage full). |

### Changed

| Path | Change |
|---|---|
| `demo/src/mock/format.ts` | `NodeFile.suggestions?: StoredSuggestion[]` (type from `server/src/storage/suggestions.ts`). `parseFrontmatter` also returns `raw: Record<string, string>` (trimmed, not unquoted). This keeps a YAML-quoted string such as `suggestions: "[…]"` MISSING, as the contract requires, instead of letting `unquote` turn it into JSON. `parseNodeFile`: if `raw.suggestions` is present, `parseStoredSuggestions(tryJson(raw.suggestions))`, where a `JSON.parse` failure gives `undefined`. Set the property only when the result is defined, so deep-equal tests on old files keep passing. `serializeNodeFile(node)`: today's output, then `setSuggestionsLine(out, node.suggestions)` only when `node.suggestions` is an array (including `[]`). New export `spliceSuggestions(text, items) = setSuggestionsLine(text, items)` for the later write. Keep the module free of Node APIs. |
| `demo/src/mock/format.test.ts` | Cases below. |
| `demo/src/mock/trees.ts` | (1) `chain()`: build each `ChainNode` without `suggestions` (`const { suggestions: _, ...file } = node`). (2) New `suggestionsView(treeId, nodeId): SuggestionsResponse`. (3) New `suggestionChain(treeId, nodeId)`: chain records `{ id, created, user, assistant, suggestions? }` from the top-level node down to `nodeId`, used for generation input and snapshots. (4) New `usedKeys(treeId, targetIds): Map<NodeId, Set<string>>`: `suggestionKey(child.user)` for the live children of each target. It reuses the `readChildren` filter (`isNodeName`, not reserved, parseable `node.md`), so soft-deleted `.deleted-*` folders never count. (5) New `writeSuggestions(treeId, nodeId, snapshot, items): 'written' \| 'stored' \| 'gone' \| 'changed'`, the verified write (below). (6) `NodeFile` import now carries `suggestions`. `createNode` is unchanged in signature: a `node.suggestions` array is written in the same transaction through `serializeNodeFile`. |
| `demo/src/mock/questions.ts` | `QuestionsOptions.suggestions: Suggestions`. `Entry.pendingSuggestions: PendingSuggestions \| null`. Start it at the `naming` transition, peek and adopt at commit, abort on cancel or failure (see "Runner changes"). |
| `demo/src/mock/demo.ts` | Build `Suggestions` before `Questions` and pass it in. New `DemoOptions.suggest?: SuggestSimulator` (test hook, like the server's `fakeAgent`). New `api.getSuggestions` / `api.generateSuggestions`. `Demo` exposes `suggestions` for tests. |
| `demo/src/mock/errors.ts` | `SUGGESTIONS_FAILED_MESSAGE = 'Could not generate suggestions. They will be retried the next time the node is opened.'` (exact, from contract `errors.ts`) and `suggestionsFailed = () => new ApiError(502, SUGGESTIONS_FAILED_MESSAGE, 'suggestions_failed')`. |
| `demo/src/mock/client.ts` | No change expected; `api` is `demo.api`. Re-check `exportsComplete` once the web client lands, and mirror any new top-level export. |
| `demo/src/mock/test-helpers.ts` | `NODE(user, created, suggestions?)`: when `suggestions` is given, add the write-form line `suggestions: <JSON>` before the closing `---`. `makeDemo` passes through `suggest`. Add a `scriptedSuggest()` helper that records calls, returns scripted `{ delayMs, picks \| 'fail' }` and supports a manual gate (resolve later) for dedup and race tests. |
| `demo/src/mock/questions.test.ts` | At-save cases below. Existing tests stay green. The default simulator with `random: () => 0.5` must not change question events (only `node.md` gains a line). |
| `demo/src/mock/demo.test.ts` | Chain payload has no `suggestions` key. Structural routes never get a 409 from a running suggestion generation. |
| `demo/src/mock/seed.test.ts` | Seed suggestion invariants and showcase guards (below). |
| `demo/seed/rust-ownership/**/node.md` | Add `suggestions:` lines to some nodes (see "Seed"), plus one plan sentence in `what-is-ownership`'s answer. |
| `CLAUDE.md` (repo, Demo section) | One bullet at the end of implement: `mock/suggestions.ts` simulates suggestion generation (at save in parallel with naming, lazy POST with dedup, verified write, no lock) using the pure helpers from `server/src/storage/suggestions.ts`. Seed nodes cover stored, empty, inherited and missing lists. |

## Data model (node.md in the VFS)

The contract's `node-file.ts` is the spec. Demo specifics:
- **Read.** Only the write form must be read: one line `suggestions: <json>`. The flat parser
  splits on the first `:`, so `: ` inside the JSON (texts like `"Rust: why?"`) is safe. Any other
  shape gives MISSING: a block-style YAML list (its continuation lines have no `key:`, so the
  parser sees `suggestions:` with an empty value), `null`, a quoted string, or invalid JSON. The
  server accepts block lists; the demo never writes them, and the seed must not contain them
  (`seed.test.ts` checks this).
- **Write.** New node: `setSuggestionsLine(serializeNodeFile(without), items)`, so the line is
  last before the closing `---`, with LF. Later write: `setSuggestionsLine(raw, items)` on the raw
  text read in the same transaction. Every other byte stays as it is.
- **Item invariants** (from the server's `finalizeSuggestions`): own items first, at most 5,
  inherited items point at the original owner. The demo never writes items it did not get from
  `finalizeSuggestions`.

## Read path: `TreeStore.suggestionsView(treeId, nodeId)`

Validation order, as in the server plan (`ensure` / `view`):
1. `assertTree(treeId)` → 404 `tree_not_found`.
2. `nodeIdSegments(nodeId)` → 400 (`Invalid node id: …`, the existing message of `names.ts`).
   `nodeId === ''` → 400 `'The tree root has no suggestions'`.
3. Node missing → 404 `node_not_found` (use `assertNode`, not `chain()`, whose 404 has no code).
4. `records = suggestionChain(treeId, nodeId)`. `used = usedKeys(treeId, records.map(r => r.id))`
   (all chain ids; cheap in memory and a superset of the possible targets).
   `resolveSuggestions(records, used)`.
5. `'missing'` → `{ node: nodeId, state: 'missing', suggestions: [] }`, else
   `{ node: nodeId, state: 'ready', suggestions }`.

The route layer also checks `typeof node === 'string' && node.length <= 1000` before step 1, and
otherwise throws 400 `'Invalid input'` (the Zod schema step). NFC is applied in `demo.ts` (`nfc`).

## Verified write: `TreeStore.writeSuggestions(treeId, nodeId, snapshot, items)`

One synchronous `mutate` (a VFS transaction). JS is single-threaded and every VFS call is
synchronous, so check and write are atomic against moves, deletes and other writers:
1. `isTreeId(treeId)` and `tree.md` exists, else `'gone'`.
2. Validate `nodeId` without throwing (invalid → `'gone'`). `path = <tree>/<node>/node.md`.
   `vfs.isFile(path)` must be true, else `'gone'`. **This check is mandatory:** `Vfs.write`
   creates missing parent folders, so writing without it would recreate a moved or deleted
   folder.
3. Parse the raw text (a parse error → `'changed'`). `created`, `user` and `assistant` must equal
   the snapshot, else `'changed'` (this also covers "id now resolves to a different node").
4. `suggestions !== undefined` → `'stored'` (another writer won; discard ours).
5. `vfs.writeText(path, setSuggestionsLine(raw, items))` → `'written'`.
6. A full storage (`StorageFullError` → `mutate` throws the 413 `ApiError`) rolls back and is
   caught by the service: a lazy POST answers 502 `suggestions_failed`, an adopted write is
   dropped silently. Either way the node stays MISSING.

## Generation service: `mock/suggestions.ts`

```ts
export interface SimulatedSuggestInput {
  treeId: string;
  /** Undefined for the at-save case (node not committed yet). */
  nodeId?: string;
  ancestors: Array<{ id: string; user: string; assistant: string }>; // top-level first
  current: { user: string; assistant: string };
  candidates: SuggestionCandidate[];
}
export interface SimulatedSuggestResult { delayMs: number; picks: SuggestPick[] | 'fail' }
export type SuggestSimulator = (input: SimulatedSuggestInput) => SimulatedSuggestResult;

export class Suggestions {
  constructor(o: { trees: TreeStore; schedule: Schedule; simulate: SuggestSimulator });
  view(treeId: string, nodeId: string): SuggestionsResponse;           // GET
  ensure(treeId: string, nodeId: string): Promise<SuggestionsReady>;   // POST
  forAnswer(i: { treeId: string; parentId: string; question: string; answer: string }): PendingSuggestions;
  /** Test aid: number of generations in flight (dedup map size). */
  inFlight(): number;
}
export interface PendingSuggestions {
  peek(): StoredSuggestion[] | null | undefined; // ready / failed / running
  adopt(treeId: string, nodeId: string, snapshot: { created: string; user: string; assistant: string }): void;
  abort(): void;
}
```

Internals:
- `generate(treeId, chainRecords, current, nodeId?)`: `ancestors = chainRecords` (top-level
  first). `askedKeys` = keys of every ancestor `user` plus `current.user`. Candidates:
  `pickCandidates(ancestors, usedKeys(treeId, ancestor ids), askedKeys)` (server plan signature,
  see open question 1). Then call `simulate(...)` and wait `delayMs` through `schedule`. The
  returned promise rejects on `'fail'` or on abort. Otherwise it resolves with
  `finalizeSuggestions(picks, candidates, { depth: ancestors.length, askedKeys })`. The abort
  handle cancels the scheduled timer and rejects.
- **Dedup map** `Map<string /* tree\0node */, Promise<StoredSuggestion[]>>`. The entry is
  deleted in `finally` (success or failure), so the next open can retry. An adopted at-save
  generation is registered under its committed `(tree, nodeId)` key.
- **`ensure(tree, node)`**: validate as in the read path (throws 400/404 synchronously, before any
  generation). If the list is stored, return `view` at once (no simulator call). Otherwise join or
  start under the key. The started generation captures `snapshot = { created, user, assistant }`
  of the node and, on success, calls `writeSuggestions`:
  - `'written'` / `'stored'` → resolve.
  - `'changed'` → reject with `suggestionsFailed()` (502).
  - `'gone'` → reject with the 404 that `trees.suggestionsView(tree, node)` throws now:
    `tree_not_found` if the tree was renamed, `node_not_found` if the node was moved, renamed or
    deleted. If the id unexpectedly resolves again, throw `node_not_found` anyway.
  - A simulated failure, an abort, or the 413 from the write → `suggestionsFailed()`.
  After the shared promise settles, `ensure` returns `view(tree, node)`; a 404 there passes
  through. Joined callers get the same outcome.
- **`forAnswer`**: reads `suggestionChain(treeId, parentId)` (fresh ancestor lists; `''` →
  `[]`). A read error counts as failure (`peek() === null`). Then `generate` with
  `current = { user: question, assistant: answer }` and no `nodeId`. `peek` reflects the settled
  value. `adopt` registers the running promise in the dedup map under `(tree, nodeId)` and
  chains the verified write with the given snapshot; every outcome other than `'written'` is
  discarded silently (no event, no error). `abort` cancels a non-adopted generation; after
  `adopt` it is a no-op (as on the server, an adopted generation is not tied to the question).
- **No lock.** `Suggestions` never touches `TreeLocks`. Structural routes take their exclusive
  lock as today and are never refused because of a generation.
- **Tree rename or move during an adopted or lazy generation.** The write targets the old
  `(tree, nodeId)` → `'gone'` → discarded. The result is never written to the new location
  (contract: discard). A later POST under the new id starts a fresh generation (different key).

### Default simulator `simulateSuggestions(random)`

Deterministic for a given `random`; English templates (the seed tree and the UI are English,
simulated answers are Lorem ipsum):
- `topic` = first line of `current.user`, whitespace-collapsed, trailing `?`/`.`/`!` removed, cut
  to 6 words with `truncateGraphemes`. For a files-only question (`Attached files: …`) use
  `"these files"`.
- **Plan mode** (`/\b(plan|steps?|chapters?|roadmap|outline)\b/i` matches `current.user`): own
  texts `Let's start with step 1 of ${topic}`, `Let's go to step 2 of ${topic}`,
  `Let's go to step 3 of ${topic}`. Keep every candidate. This lets a visitor see inheritance:
  ask "Make a plan …", click step 1, and the child shows steps 2 and 3 inherited from the plan
  node.
- **Otherwise**, using `r = random()`:
  - `r < 0.12` → `picks: []` (stored EMPTY, "nothing obvious");
  - `0.12 ≤ r < 0.2` → `'fail'` (at save: the node stays MISSING and the web's lazy POST then
    generates it on open, which exercises the lazy path live). For lazy calls (`nodeId` set) the
    default simulator never fails, so the demo does not show the 502 path to visitors.
  - else 1–3 own texts from a pool (`Can you show a bigger example of ${topic}?`,
    `What are common mistakes with ${topic}?`, `Give me a short exercise on ${topic}`,
    `How does ${topic} work under the hood?`), then each candidate kept with probability 0.7
    (`{ keep: i }`). `finalizeSuggestions` enforces the order, dedupe, asked-filter and cap.
- `delayMs`: at save `250 + floor(random() * 750)` (naming takes 400–700 ms, so roughly a third
  of the generations outlive the commit and are adopted); lazy `600 + floor(random() * 900)`.
- With the test random `() => 0.5`: not plan mode → 2 own items, candidates kept
  (0.5 < 0.7), at-save delay 625 ms > naming 550 ms → adopted. Tests that need other behaviour
  pass `DemoOptions.suggest`.

## Runner changes (`mock/questions.ts`)

1. In `run()`, right before `setStatus(entry, 'naming')`, start
   `entry.pendingSuggestions = suggestions.forAnswer({ treeId: info.tree, parentId, question:
   namingQuestion, answer: live.answer.trim() })`. `namingQuestion` is computed as in `commit`
   (hoist it into a helper). This runs while the shared lock is held (status `naming`), so the
   chain cannot move.
2. `commit()`: `const ready = entry.pendingSuggestions?.peek()`. Pass
   `...(Array.isArray(ready) ? { suggestions: ready } : {})` to `createNode`. Hoist `created` into
   a const. After `createNode` succeeds, if `ready === undefined`, call
   `pending.adopt(info.tree, nodeId, { created, user: info.text, assistant })`. Then set
   `entry.pendingSuggestions = null`. The rest is unchanged; `done` is emitted at once, and the
   question never waits for or fails because of suggestions.
3. `fail()` and `remove()` (cancel, dismiss, `dropUnder`): `entry.pendingSuggestions?.abort()`,
   then null. `createNode` failure → `fail()` → aborted. `retry` starts a fresh `forAnswer` at
   its own `naming` step.
4. `snapshot()`, `blockers()`, events: unchanged.

Note: the mock commits with `user: info.text` (the raw text; `''` for files-only). The snapshot
must use the same value that was written, or the verified write would report `'changed'`.

## Routes (`mock/demo.ts`)

```ts
getSuggestions: (id, node) => respond(() => {
  checkNodeParam(node);                       // 400 'Invalid input' (Zod step)
  return suggestions.view(id, nfc(node));     // 404 tree/node, 400 root/invalid
}),
generateSuggestions: (id, node) => respond(() => {
  checkNodeParam(node);
  return suggestions.ensure(id, nfc(node));   // 200 ready | 404 | 502; never 409
}),
```
Neither calls `locks`. `respond` adds the usual 40–120 ms latency on top of the simulator delay.
`DEMO_MODELS` and `getModels` are unchanged (contract: no `defaults.suggest` on the wire).

## Seed (`demo/seed/rust-ownership/`)

Edit the `node.md` frontmatters only (one line each), plus one sentence in an answer. Texts are
ASCII, already sanitized (`sanitizeSuggestionText(t) === t`), and use the exact write form
(`JSON.stringify`, no spaces).

| Node | `suggestions` | Shows |
|---|---|---|
| `what-is-ownership` | own: `Why can't I use a String after assigning it to another variable?`, `How do references and borrowing work?`, `How do slices borrow part of a String?`, `What happens to ownership when I pass a value to a function?` (all `up: 0`) | The plan-like parent. The first two equal the `user` of its children `move-semantics` and `borrowing-rules`, so they are **hidden as used**. The last two are shown. Add one sentence before **Exercise:** in the answer: "A good path from here: first moves, then references and borrowing, then slices." (keeps the footnote rules of `seed.test.ts`). |
| `what-is-ownership/move-semantics` | own: `Show me how to return ownership from a function`; inherited: `How do references and borrowing work?` (`up: 1`, used → hidden), `How do slices borrow part of a String?` (`up: 1`) | Inherited button asked from the parent: a click creates a sibling of `move-semantics`. |
| `what-is-ownership/move-semantics/clone-or-copy` | own: `Which standard types implement Copy?`; inherited: `Show me how to return ownership from a function` (`up: 1`), `How do slices borrow part of a String?` (`up: 2`) | `up ≥ 2` resolution. |
| `what-is-ownership/borrowing-rules` | own: `How do lifetimes relate to borrowing?`, `Can I borrow mutably inside a loop?`; inherited: `How do slices borrow part of a String?` (`up: 1`), `What happens to ownership when I pass a value to a function?` (`up: 1`) | Mixed list; at most 5. |
| `.../borrowing-rules/dangling-references` | `[]` | STORED EMPTY: no buttons, no POST, never regenerated. |
| `.../borrowing-rules/mutable-references` | key absent | MISSING → lazy POST on open. |
| `.../mutable-references/scoped-borrows` | key absent | MISSING. Its lazy generation skips the missing parent and takes candidates from `borrowing-rules` (nearest stored), producing `up: 2` / `up: 3` items. |
| `stack-and-heap` | key absent | Top-level MISSING node (lazy, no candidates). |
| `stack-and-heap/box-and-rc` | own: `When should I use Arc instead of Rc?`, `How does RefCell work with Rc?` | Own-only list under a parent without a list (no inheritance). |

Persisted VFS state: do **not** bump `otago-demo:vfs:v1`. Returning visitors keep their stored
tree without the new lines, which is valid (every node is MISSING and goes through the lazy path).
"Reset demo" loads the new seed.

## Step ordering

1. Prerequisites outside `demo/`: the server's pure `server/src/storage/suggestions.ts` (server
   step 2), and the web's `types.ts` + `client.ts` additions (`getSuggestions`,
   `generateSuggestions`, `suggestions_failed` in `ApiErrorCode`). Until then `demo` does not
   type-check (`DemoApi = typeof realApi`).
2. `mock/format.ts` + `format.test.ts` (raw value, parse, serialize via `setSuggestionsLine`).
3. `mock/errors.ts` (`suggestionsFailed`).
4. `mock/trees.ts`: chain strip, `suggestionChain`, `usedKeys`, `suggestionsView`,
   `writeSuggestions`.
5. `mock/suggestions.ts` (service + simulator), then `demo.ts` wiring + routes, then
   `test-helpers.ts` (`NODE` with suggestions, `scriptedSuggest`, `suggest` passthrough).
6. `mock/questions.ts` runner changes.
7. Tests: `suggestions.test.ts`, `questions.test.ts` and `demo.test.ts` additions.
8. Seed edits + `seed.test.ts` guards.
9. Confirm `mock/client.ts` `exportsComplete` against the final web client. Update CLAUDE.md
   (Demo section). Run `pnpm check`, then `pnpm --filter @otago/demo lint` and
   `pnpm --filter @otago/demo test`, then `pnpm build` (`demo` build runs `tsc --noEmit`). Manual
   check with `pnpm demo`: seed buttons, lazy generation on `stack-and-heap`, the plan flow from a
   new question.

## Test plan

All tests use `makeDemo()` (`latency: () => 0`, fake timers where delays matter). Generator
behaviour is controlled with `DemoOptions.suggest` (`scriptedSuggest`) except where the default
simulator itself is under test.

### `format.test.ts`
- Old node (no key): `parseNodeFile` result has no `suggestions` property (`toEqual` with the
  old shape). `serializeNodeFile` output is byte-identical to the pre-feature output.
- `suggestions: []` → `[]`. Items with text containing `: `, `#`, quotes, backslash, Cyrillic and
  U+2028 round-trip through `serializeNodeFile` → `parseNodeFile`.
- MISSING for: `suggestions: null`, `suggestions: "[]"` (quoted string), `suggestions: {}`,
  invalid JSON, and a block-style list (`suggestions:\n  - text: x`).
- Invalid items are dropped and the list stays stored; unknown item keys are ignored.
- `serializeNodeFile` with suggestions equals `setSuggestionsLine(serializeNodeFile(without),
  items)`, and the line is the last frontmatter line.
- Server-written form (gray-matter frontmatter + spliced line) parses identically.

### `suggestions.test.ts` (service and routes through `demo.api`)
- GET: missing node → `{ state: 'missing', suggestions: [] }`. Stored `[]` → `ready, []`. A
  3-level hand-written chain (`NODE(…, suggestions)`) resolves own and inherited items with
  correct `target` / `up`. Own wins over an inherited duplicate.
- GET "used": add a child under the target whose `user` equals a suggestion (also NFD, padded
  whitespace) → hidden. Soft-delete that child → shown again.
- GET after move: move a node with an inherited item under another parent → the item disappears.
  Move it back → it reappears.
- GET/POST errors: `''` → 400 (`The tree root has no suggestions`), malformed id → 400, a node
  string over 1000 chars → 400 `Invalid input`, unknown tree → 404 `tree_not_found`, unknown node
  → 404 `node_not_found`.
- POST on a missing node: one simulator call. `node.md` equals `setSuggestionsLine(before,
  items)` (all other bytes kept). The response is `ready`. A second POST makes no call.
- POST on a stored node: no simulator call.
- Dedup: two concurrent POSTs plus a GET while the scripted generation is gated → exactly one
  simulator call. Both POSTs resolve to equal lists. `inFlight()` is 0 afterwards.
- Failure: `'fail'` → 502 with code `suggestions_failed` and the exact message; the file has no
  key; the next POST calls the simulator again and succeeds.
- No lock: with a gated generation, `moveNodes`, `renameNode`, `deleteNodes`, `restoreNodes` and
  `updateTree({ title })` all succeed (no 409). Then open the gate:
  - moved/renamed → POST rejects 404 `node_not_found`; the node at its new id has no key;
  - deleted → 404 `node_not_found`; the trash folder's `node.md` is unchanged; `vfs.exists(old
    folder)` is false (no folder recreated);
  - tree renamed → 404 `tree_not_found`; nothing written under either tree id;
  - moved away and back before the gate opens → written.
- Changed during generation (rewrite `assistant` via `vfs.transaction`) → 502, nothing written.
- Stored by another writer meanwhile (write the line by hand) → 200 with that stored list; ours
  discarded.
- Storage full: `storage.failNextSave()` before the gate opens → 502 `suggestions_failed`, VFS
  rolled back (no key), and the next POST succeeds.
- Inheritance through the lazy path: chain plan (stored own `A`, `B`, `C`) → child `A` (missing,
  `user: 'A'`). POST on the child → the simulator receives candidates `B`, `C` (`A` excluded as
  asked) with `source` = plan id and `origin` 0. With picks `{keep:0},{keep:1}` the stored items
  are `up: 1`.
- Missing ancestors are skipped: grandparent stored, parent missing → candidates come from the
  grandparent with `origin` 0 and the stored `up: 2`.
- Default simulator (pure function tests): plan-mode keyword → 3 step texts + keep-all; `r < 0.12`
  → `[]`; the fail band only at save; deterministic for a fixed `random`.

### `questions.test.ts` additions
- Generation faster than naming (scripted `delayMs: 100`): after `runAllTimersAsync`, the
  committed `node.md` contains the line (written once together with the node; check the file
  `version` is that of the commit).
- Generation slower than naming (gated): the `done` event arrives while the gate is closed and
  the node has no key. A POST for the new node issued now joins (still one simulator call). Open
  the gate → the key appears and the POST resolves `ready`.
- Generation fails at save: done, no key; events are exactly `['streaming', 'naming', 'done']`.
- Cancel during naming (`cancelQuestion` while `naming`): no node, no write later (advance
  timers past the scripted delay); the simulator handle reports aborted.
- `fail` wording (simulated answer failure) never starts a generation (it fails before naming).
  Retry starts one at its own naming step.
- End-to-end inheritance with the default simulator: ask `Make a plan for ownership` at the root
  → node gets the 3 step suggestions. Ask the step-1 text under it → the child stores steps 2 and
  3 with `up: 1`, and GET on the child returns `target` = plan node id. Ask step 2 under the plan
  → GET on the child no longer shows it (used).
- Existing tests unchanged and green.

### `demo.test.ts` additions
- `getChain` items have no `suggestions` property, even for nodes with stored lists.
- `getTree` / hierarchy unaffected by a `suggestions` line.

### `seed.test.ts` additions
- Every seed `node.md` containing `suggestions:` uses the exact write form: the raw line equals
  `setSuggestionsLine`'s output for the parsed items (canonical JSON, one line, before the closing
  `---`). No block-style lists.
- Every stored text is sanitized (`sanitizeSuggestionText(t) === t`), ≤ 5 items, own before
  inherited.
- Every inherited item resolves: `up < depth`, and the target ancestor has a stored list with an
  own item of the same key (the server's write invariant).
- Showcase guards: at least one MISSING node, one stored-empty node, one inherited item with
  `up ≥ 2`, and one suggestion hidden as used (`suggestionsView` returns fewer items than stored
  for `what-is-ownership`).
- Existing citation and PDF guards still pass with the edited `what-is-ownership` answer.

## Open contract questions

1. **`pickCandidates` signature.** Contract `generation.ts` documents
   `pickCandidates(chain, usedKeysByTarget)` and derives the asked-keys exclusion inside; the
   server plan lists `pickCandidates(chain, usedKeysByTarget, askedKeys)`. The demo calls whatever
   `server/src/storage/suggestions.ts` exports. Please fix one form in the contract.
2. **`setSuggestionsLine` on a file without frontmatter.** The server plan says it throws. The
   demo only calls it on files it has just parsed (so frontmatter exists) and maps a throw to
   `'changed'`. Please confirm that throwing is the intended contract, not a no-op.
3. **Storage full / disk full during a lazy write.** The contract has no status for a write I/O
   failure on `POST …/suggestions`. The demo (localStorage quota, its 413 elsewhere) maps it to
   502 `suggestions_failed` with the node left MISSING. Please confirm the server does the same
   for ENOSPC or EACCES, rather than a 500.
4. **Client method names and shapes** (to reconcile with the web plan): `api.getSuggestions(tree,
   node) → SuggestionsResponse` and `api.generateSuggestions(tree, node) → SuggestionsReady`, no
   response envelope, `'suggestions_failed'` in `ApiErrorCode`. If the web chooses other names or
   adds an envelope, the mock follows the web client, because the `DemoApi` type enforces it.
5. **Demo-only behaviour, not a contract change:** the default simulator never fails on the lazy
   path, so a visitor never sees the 502. The 502 path is covered by tests through the hook. The
   web planner should not rely on the demo to show its 502 handling.
