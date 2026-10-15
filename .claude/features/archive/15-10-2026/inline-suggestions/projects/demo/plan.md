# Demo plan: inline suggestions

Role: client. Contract: `.claude/features/inline-suggestions/contracts/` (owner: server). Read
`block.ts`, `suggestions.ts`, `suggestions-api.ts` and `agent.ts` ("Runner") first. The demo
mock reproduces the server side: the simulated answering agent may end its answer with a
suggestion block, the mock streams it through the server's `SuggestionBlockFilter`, and at the
commit stores `finalizeSuggestions(splitSuggestionBlock(raw).items, …)` with the node. All
algorithms come from the server's pure modules, imported as-is:

- `server/src/storage/suggestions.ts` (changed by the server plan: `MAX_SUGGESTIONS`,
  `SuggestPick`, `SuggestionsMissing` gone; `SuggestionChainNode.user` required;
  `resolveSuggestions` returns `Suggestion[]` with the ancestor fallback; `pickCandidates` =
  parent's resolved list minus asked keys; `finalizeSuggestions(texts, candidates, ctx)`).
- `server/src/storage/suggestion-block.ts` (new: `SUGGESTIONS_MARKER`, `SuggestionBlockFilter`,
  `splitSuggestionBlock`, `suggestionBlock`).

Import them by file path (`../../../server/src/storage/suggestion-block`), never through
`server/src/storage/index.ts` (that barrel re-exports Node modules).

This plan lands in the same change as the server and web plans: the demo compiles against the
changed server modules and against `web/src/api/{client,types}.ts`.

## Summary of decisions

| Topic | Decision |
|---|---|
| Separate generator (`Suggestions` class, lazy POST, adoption, verified later write, dedup) | Deleted. `mock/suggestions.ts` shrinks to a pure, synchronous "block simulator" (what the model would write in its block). |
| Where the block comes from | `Questions.run` asks the simulator once per attempt, before streaming, with the parent's open suggestions (`openSuggestions`, like `AskInput`). The returned texts become `suggestionBlock(texts)`, appended to the simulated answer AFTER the footnotes (`withCitations`), so it is the very end of the answer (contract `block.ts`: a marker followed by any other line is not a block). |
| Streaming | One `SuggestionBlockFilter` per attempt. Every token chunk goes through `push`; only non-empty output becomes a `chunk` event and is appended to `live.answer`. After the last token, `end()` is emitted (if non-empty) before the status goes to `naming`. Cancel/failure: `end()` is never called. |
| Commit | `split = splitSuggestionBlock(raw.trim())`; `assistant = split.answer`; `suggestions = split.items === undefined ? undefined : finalizeSuggestions(split.items, candidates, { depth, askedKeys })`, passed to `TreeStore.createNode` (the only writer, E12). |
| Candidates | Computed at the start of each attempt (shared lock held, like the server runner step 1): `ancestors = trees.suggestionChain(tree, parentId)`, `askedKeys = { key(a.user) } ∪ { key(job.text) }`, `candidates = trees.suggestionCandidates(tree, ancestors, askedKeys)`. Any error → `[]` (the server logs a warning; the demo has no logger). A retry recomputes everything. |
| GET | `TreeStore.suggestionsView` always returns `{ node, state: 'ready', suggestions }` (ancestor fallback, no cap, no lock, never 409). |
| POST | Removed from `api` (`generateSuggestions` gone, matching the real client). |
| `suggestions_failed` | Removed (`errors.ts`). |
| Test hook | `DemoOptions.suggest` keeps its name, new type `BlockSimulator`. `scriptedSuggest` is replaced by `scriptedBlocks` (synchronous, records inputs). |
| Rejected markers / empty answers | Not simulated. The default simulator always writes a valid final block or none, and Lorem answers are never empty. The parsing of bad blocks is tested on the server (same pure module). |
| Stored VFS state of returning visitors | No migration, no VFS key bump: nodes without a list now just inherit (E1, E9). |

## Files

### Changed

#### `demo/src/mock/suggestions.ts` (rewrite: simulator only)

Delete everything that mirrors `server/src/suggestions/service.ts`: `Suggestions`,
`PendingSuggestions`, `Generation`, `SimulatedSuggestInput`, `SimulatedSuggestResult`,
`SuggestSimulator`, `untilAborted`, `aborted`, `keyOf`, the imports of `ApiError`, the web types,
`errors.ts`, `Schedule`, `TreeStore` and `SuggestPick`.

New header comment: the demo's stand-in for the answering agent's block (contract
`inline-suggestions/contracts/agent.ts`, prompt section "Next questions"). Pure: no I/O, no
timers, deterministic for a given `random`.

Exports:

```ts
export interface SimulatedBlockInput {
  treeId: string;
  parentId: string;
  /** The question text as sent (`''` for a files-only message). */
  question: string;
  /** Texts of the parent's open suggestions, in order (what the server puts in <open-suggestions>). */
  openSuggestions: readonly string[];
  attempt: number;
}

/** Item texts of the block to append; `undefined` = no block; `[]` = the marker line alone. */
export type BlockSimulator = (input: SimulatedBlockInput) => readonly string[] | undefined;

export function suggestionTopic(question: string): string; // kept as today
export function simulateSuggestionBlock(random: () => number): BlockSimulator;
```

Default simulator rules (keep `PLAN_RE`, `STEP_RE`, `PLAN_REQUEST_RE`, the topic helpers and
`OWN_TEMPLATES`; replace `EMPTY_BELOW` / `FAIL_BELOW` / `KEEP_PROBABILITY` with the constants
below):

1. Plan-like question that is not itself a step (`PLAN_RE` matches, `STEP_RE` does not): block
   = the three step texts (`Let's start with step 1 of <topic>`, `Let's go to step 2 …`,
   `… step 3 …`) followed by every open suggestion verbatim.
2. A step question (`STEP_RE` matches): the obvious next steps are the remaining steps, so block
   = every open suggestion verbatim (step 1 under the plan keeps steps 2 and 3, stored with
   `up: 1`). No open suggestions → no block.
3. Otherwise, one `r = random()`:
   - `r < NO_BLOCK_BELOW` (0.4): no block (the common "often none" case: open suggestions stay
     visible through inheritance).
   - `r < EMPTY_BELOW` (0.5): when there are open suggestions, the marker line alone (`[]`,
     drops them all and stops inheritance, E2); without open suggestions, no block.
   - else: 1–2 own template texts (`1 + floor(random() * 2)`, starting at
     `floor(random() * OWN_TEMPLATES.length)`) followed by each open suggestion kept verbatim
     with probability `KEEP_PROBABILITY` (0.7).

   With the tests' constant `random = () => 0.5` this is the last branch, so an answer of the
   default simulator ends with a block (two own items plus every open suggestion), which is what
   lets the existing citation tests double as "block stripped, footnotes intact" checks.
   No delay, no failure mode: the block is part of the streamed answer (the existing `fail`
   word still fails the answer itself).

#### `demo/src/mock/questions.ts`

- Header comment: replace the "Suggestions are generated in parallel with naming" sentence with:
  the simulated answer may end with a suggestion block (simulator from `suggestions.ts`), withheld
  from chunks by `SuggestionBlockFilter` and split off at the commit; contract
  `.claude/features/inline-suggestions/contracts/agent.ts` "Runner".
- Imports: drop `PendingSuggestions, Suggestions`. Add from
  `../../../server/src/storage/suggestion-block`: `SuggestionBlockFilter`,
  `splitSuggestionBlock`, `suggestionBlock`. From `../../../server/src/storage/suggestions`:
  `finalizeSuggestions`, `suggestionKey`, `type SuggestionCandidate`. `type BlockSimulator` from
  `./suggestions`.
- `QuestionsOptions`: replace `suggestions: Suggestions` with `suggest: BlockSimulator`.
  Field `private readonly suggest: BlockSimulator`.
- `Entry`: remove `pendingSuggestions` (and its initializer in `start`). Remove
  `dropSuggestions` and its three call sites (`run`, `fail`, `remove`).
- `run(entry)`:
  1. Read the attempt's suggestion state first (the shared lock is held):
     ```ts
     const { tree, parentId } = entry.info;
     const state = this.suggestionState(tree, parentId, text); // { candidates, askedKeys, depth }
     ```
     `suggestionState` (new private method) wraps `trees.suggestionChain` +
     `trees.suggestionCandidates` in `try/catch`, returning `{ candidates: [], askedKeys,
     depth }` on error (`depth` = chain length, `0` when the chain could not be read).
  2. Build the answer as today (`withCitations(loremAnswer(...), this.citeRefs(entry), ...)`),
     THEN call `this.suggest({ treeId: tree, parentId, question: text, openSuggestions:
     state.candidates.map((c) => c.text), attempt })` and set `raw = answer + (texts ?
     suggestionBlock(texts) : '')`. (Calling the simulator after the answer keeps the answer's
     random sequence unchanged.)
  3. `tokens = streamTokens(raw)`, `filter = new SuggestionBlockFilter()`. In `tick`, compute the
     chunk as today, then `const shown = filter.push(chunk)`; only when `shown !== ''` append it
     to `live.answer` and emit the `chunk` event (offset = `live.answer.length` before the
     append, so offsets stay contiguous over emitted text only).
  4. `failAt` stays `floor(tokens.length * 0.4)` (now over the raw tokens; it never matters
     whether the cut falls in the block: nothing withheld is ever emitted on failure).
  5. After the last token: `const rest = filter.end()`; emit it like a chunk when non-empty;
     then `setStatus('naming')` and schedule `this.commit(entry, attempt, raw, state)`.
- `commit(entry, attempt, raw, state)`:
  - `const split = splitSuggestionBlock(raw.trim())`;
    `const suggestions = split.items === undefined ? undefined :
    finalizeSuggestions(split.items, state.candidates, { depth: state.depth, askedKeys:
    state.askedKeys })`.
  - `createNode(..., { created, model, user: info.text, assistant: split.answer,
    ...(suggestions && { suggestions }) }, entry.files)`.
  - Remove the `pending.peek()` / `adopt` logic and the "never waits for suggestions" comment.
  - `split.answer` equals `live.answer.trim()` by the filter invariant; the stored answer is
    taken from the split, not from `live.answer` (as on the server).
- Retry needs no extra code: `retry` calls `run`, which recomputes the state, asks the simulator
  again (`attempt` + 1) and creates a fresh filter.

#### `demo/src/mock/trees.ts`

- Imports from `server/src/storage/suggestions`: `pickCandidates`, `resolveSuggestions`,
  `suggestionKey`, `suggestionTargets`, `type SuggestionCandidate`, `type SuggestionChainNode`.
  Drop `StoredSuggestion` if unused, `spliceSuggestions`, and any `names.ts` import that only
  `writeSuggestions` used (e.g. `isTreeId`, if nothing else uses it; let `pnpm lint` decide).
- Delete `SuggestionRecord`, `SuggestionSnapshot`, `SuggestionWrite`, `writeSuggestions`.
- `suggestionChain(treeId, nodeId): SuggestionChainNode[]` returns `{ id, user, ...(suggestions
  && { suggestions }) }` (no `created`/`assistant`; nobody needs them any more).
- `suggestionsView(treeId, nodeId)`: same validation order as today (`assertTree`,
  `nodeIdSegments`, `''` → 400 'The tree root has no suggestions', `assertNode`), then
  `used = this.usedKeys(treeId, suggestionTargets(records))` and return `{ node: nodeId, state:
  'ready', suggestions: resolveSuggestions(records, used) }`. Return type: the web's ready shape
  (`SuggestionsReady`, or `SuggestionsResponse` if the web keeps it as the alias of
  `SuggestionsReady`). Doc comment: "resolved list with the ancestor fallback; always ready;
  pure read, no lock".
- New `suggestionCandidates(treeId, ancestors, askedKeys): SuggestionCandidate[]`, the mirror of
  the server's `readCandidates`: `pickCandidates(ancestors, this.usedKeys(treeId,
  suggestionTargets(ancestors)), askedKeys)`. `[]` for `ancestors.length === 0`.
- `usedKeys` unchanged.
- Section comment `// --- Suggestions` stays; mention contract `inline-suggestions`.

#### `demo/src/mock/format.ts`

- Delete `spliceSuggestions` (no later write exists). `serializeNodeFile` / `parseNodeFile`
  unchanged.
- Header comment: contract path → `inline-suggestions/contracts/node-file.ts` (format unchanged;
  written only at node creation).

#### `demo/src/mock/demo.ts`

- Header: "The suggestions GET takes no lock (never 409); there is no suggestions POST."
- Imports: drop `Suggestions`, `SuggestSimulator`; import `type BlockSimulator,
  simulateSuggestionBlock` from `./suggestions`.
- `DemoOptions.suggest?: BlockSimulator` — doc: "The answering agent's suggestion block (test
  hook, like scripting blocks in the server's `fakeAgent` chunks). Default:
  `simulateSuggestionBlock(random)`."
- `Demo`: remove `suggestions`.
- `createDemo`: no `Suggestions`; pass `suggest: options.suggest ?? simulateSuggestionBlock(options.random ?? Math.random)`
  to `new Questions(...)`.
- `api.getSuggestions`: `checkNodeParam(node)`, then `trees.suggestionsView(id, nfc(node))`.
- Delete `api.generateSuggestions` (the real `api` no longer has it; `DemoApi = typeof realApi`
  rejects the extra property).
- Returned object: remove `suggestions`.

#### `demo/src/mock/client.ts`

No code change expected: the shim exports `api = demo.api` and re-exports the real helpers;
`generateSuggestions` lived on `api`, which is fixed in `demo.ts`. Re-check after the web change:
if the web removes or adds any top-level export of `web/src/api/client.ts`, mirror it here so
`exportsComplete` still compiles (`pnpm --filter @otago/demo lint`).

#### `demo/src/mock/errors.ts`

Delete `SUGGESTIONS_FAILED_MESSAGE` and `suggestionsFailed` (the web's `ApiErrorCode` loses
`'suggestions_failed'`, so they would no longer compile).

#### `demo/src/mock/test-helpers.ts`

- Drop the `SuggestPick`, `SimulatedSuggestInput`, `SuggestSimulator` imports, `ScriptStep`,
  `ScriptedCall` and `scriptedSuggest`.
- Add:
  ```ts
  /** One scripted block per attempt: texts, `undefined` (no block), or a function of the input. */
  export type BlockStep =
    | readonly string[]
    | undefined
    | ((input: SimulatedBlockInput) => readonly string[] | undefined);

  /** Scripted block "model": steps in order, then `fallback`; every input is recorded. */
  export function scriptedBlocks(steps: BlockStep[] = [], fallback: BlockStep = undefined): {
    simulate: BlockSimulator;
    calls: SimulatedBlockInput[];
    push(...more: BlockStep[]): void;
  };
  ```
- `NODE(user, created, suggestions?)` and `SMALL_SEED` unchanged.

#### `demo/src/mock/seed.test.ts`

- Imports: drop `MAX_SUGGESTIONS`; add `SUGGESTIONS_MARKER`, `splitSuggestionBlock` from
  `../../../server/src/storage/suggestion-block`.
- "stores suggestions in the exact write form, sanitized, own first, at most 5" → "… own first"
  (delete the `MAX_SUGGESTIONS` assertion; the rest stays).
- "every inherited seed suggestion points at an ancestor that owns the text": unchanged
  (`suggestionChain` still carries `suggestions`).
- "showcases missing, empty, deep inherited and used suggestions" → "showcases fallback,
  no-list, empty, deep inherited and used suggestions". Replace the `missing` counter with:
  - `fallback`: nodes without a stored list whose view is non-empty with every item `up > 0`
    (seed: `what-is-ownership/borrowing-rules/mutable-references` and `…/scoped-borrows`,
    inheriting `borrowing-rules`' list) — expect ≥ 1;
  - `none`: nodes without a stored list and an empty view (seed: `stack-and-heap`, top-level,
    no stored ancestor) — expect ≥ 1.
  Keep `empty`, `deep`, `hiddenAsUsed` and the `what-is-ownership` expectation.
  Pin the fallback case: `suggestionsView('rust-ownership',
  'what-is-ownership/borrowing-rules/mutable-references')` texts equal `borrowing-rules`'
  resolved texts (expected: lifetimes, loop, slices, pass-to-function), targets
  `borrowing-rules` / `what-is-ownership`, every `up` one more than in the parent's view.
  The implementer confirms the exact values by running the test.
- New: "stored seed answers never contain a suggestion block": for every seed `node.md`, the
  parsed `assistant` does not contain `SUGGESTIONS_MARKER` and
  `splitSuggestionBlock(assistant).items` is `undefined`.

#### Seed files (`demo/seed/**`)

No change. The existing nodes already cover: stored own + inherited lists, a stored `[]`
(`dangling-references`), inheritance two levels deep (`clone-or-copy`), nodes without a list
under a stored ancestor (now the fallback case) and a top-level node without any list.

#### `CLAUDE.md` (Demo section)

- Replace the "Suggested prompts" bullet with:

  > - Suggested prompts (contract `.claude/features/inline-suggestions/contracts/`): no separate
  >   generator. At the start of every attempt `mock/questions.ts` reads the parent's open
  >   suggestions (`TreeStore.suggestionCandidates`, the server's `pickCandidates`), asks the
  >   block simulator (`mock/suggestions.ts` `simulateSuggestionBlock`: plan steps plus every
  >   candidate verbatim, often no block, sometimes the marker alone; `DemoOptions.suggest`,
  >   `scriptedBlocks` in `test-helpers.ts`) and appends `suggestionBlock(texts)` after the
  >   footnotes. Chunks go through `SuggestionBlockFilter` (chunks and `live.answer` never
  >   contain the block); the commit stores `finalizeSuggestions(splitSuggestionBlock(raw).items,
  >   …)` through `createNode`, the only writer. `getSuggestions` is a pure read with the ancestor
  >   fallback (always `ready`, no cap, no lock, never 409); there is no POST. Pure helpers come
  >   from `server/src/storage/suggestions.ts` and `suggestion-block.ts` (keep both Node-free,
  >   import them by file, not via `storage/index.ts`). Seed nodes cover stored, empty,
  >   inherited, fallback and no-list cases; `seed.test.ts` checks the write form, the
  >   inheritance invariant and that no stored answer contains a block.

- In the "Seed PDFs …" bullet, after "Simulated answers (`mock/questions.ts` + `mock/cite.ts`)
  end with contract-shaped footnotes (…)", add: "optionally followed by the suggestion block,
  which is stripped before the answer is saved".

### Deleted

- Nothing as a file. `demo/src/mock/suggestions.test.ts` is rewritten (below), not deleted.

### Data model

- `node.md` in the VFS: format unchanged. The `suggestions:` line is written only by
  `createNode` at the commit, when the simulated answer carried a block (`[]` for the marker
  alone or when finalization drops every item). No code path writes into an existing node.
- No new VFS keys; `otago-demo:vfs:v1` unchanged.

### Interface changes (mock `api`)

- `getSuggestions(tree, node)`: always `{ node, state: 'ready', suggestions }`, ancestor fallback,
  no cap.
- `generateSuggestions`: removed.
- Question events: same shapes; `chunk` text and snapshot `live.answer` never contain any part of
  the block.

## Step order

1. Wait for (or do together with) the server's `storage/suggestions.ts` and
   `storage/suggestion-block.ts` and the web's `api/client.ts` / `api/types.ts` changes.
2. `errors.ts`, `format.ts`: deletions.
3. `trees.ts`: view, chain, candidates; delete the write path.
4. `suggestions.ts`: rewrite as the simulator.
5. `questions.ts`: candidates per attempt, simulator, filter, split + finalize at commit.
6. `demo.ts`: options, api (`getSuggestions`, no `generateSuggestions`), no `Suggestions`.
   Re-check `client.ts` / `exportsComplete`.
7. `test-helpers.ts`, then the tests (below).
8. `CLAUDE.md` Demo paragraphs.
9. `pnpm check` (Biome auto-fix; never hand-format), then `pnpm --filter @otago/demo lint` and
   `pnpm --filter @otago/demo test`; finally `pnpm lint` and `pnpm test` at the root once server
   and web have landed. Smoke test in the browser with `pnpm demo`: ask "Make a plan for X",
   watch the stream (no marker ever visible), click step 1, see steps 2 and 3 inherited.

## Test plan

All tests use fake timers and `makeDemo` as today. Scripted blocks via `scriptedBlocks`.

### `demo/src/mock/suggestions.test.ts` (rewrite)

GET (keep the existing cases, adapted):
- "reports stored empty lists; a node without a list inherits": `t/e` stores `[]` → `ready []`;
  `a` (no list, no stored ancestor) → `ready []`; a node without a list under a parent storing
  `own('N1')` → `[{ text: 'N1', target: parent, up: 1 }]`; a stored `[]` stops the fallback even
  if the grandparent has items.
- Fallback drops an item a node between asked (`below`): chain `g` stores `own('X','Y')`, `g/p`
  asks `X` with no list, `g/p/v` no list → view of `g/p/v` is `[Y]` (up 2), and `X` is also
  hidden as used.
- No cap: a stored list of 7 comes back with 7 items.
- Keep unchanged: chain resolution with own-wins (`CHAIN_SEED`/`CHAIN_VIEW`), used-hiding with
  NFD/padded text and delete, move away/back, NFC normalization.
- Validation: same table, GET only (`''`, `A B`, `a/files`, 1001 chars, unknown tree, unknown
  node). Add `expect('generateSuggestions' in demo.api).toBe(false)`.
- Never 409: GET succeeds while a question of the tree is streaming (start a question, do not
  run timers, call `getSuggestions`).

Candidates (`trees.suggestionCandidates`, through a question with `scriptedBlocks`):
- Parent stores `own('A','B','C')`, a live child asks `A`: a question under the parent records
  `openSuggestions` `['B','C']`.
- Parent without a list under a stored grandparent: the grandparent's open items are offered
  (fallback).
- The question's own text is not offered (asking `B` under the parent offers `['C']`).
- Top-level question: `[]`.

Default simulator (`simulateSuggestionBlock`, pure):
- Plan question: three steps then every open suggestion.
- Step question: exactly the open suggestions; none → `undefined`.
- `random` 0.1 → `undefined`; 0.45 with open suggestions → `[]`, without → `undefined`;
  0.5 → two templates (exact texts as today's expectations: `Give me a short exercise on …`,
  `How does … work under the hood?`) plus every open suggestion.
- Deterministic for a seeded sequence; `suggestionTopic` cuts the question and maps a files-only
  message to "these files".

### `demo/src/mock/questions.test.ts`

Replace "simulated questions: suggestions at save" with "simulated questions: suggestion block":

1. A block is stripped and stored: `scriptedBlocks([['Next?']])`, question under `a`. Concatenated
   chunks contain no `<!--`; saved `assistant` equals `streamed.trim()` and contains no
   `SUGGESTIONS_MARKER`; node.md stores `[{ text: 'Next?', up: 0 }]`; the node.md version at the
   `done` event equals the final version (written once, with the node). `calls[0]` matches
   `{ treeId: 't', parentId: 'a', question: …, openSuggestions: [], attempt: 1 }`.
2. Never visible while streaming: step the timers one at a time
   (`vi.advanceTimersToNextTimerAsync`) until `done`; after every step neither
   `demo.questions.snapshot()` `live.answer` nor any chunk so far contains `<!--`, and chunk
   offsets are contiguous. A connection opened mid-block (`demoConnection(...).start()` after the
   marker tokens were pushed) gets a snapshot without the block.
3. No block (`undefined`): node.md has no `suggestions` key; GET on the new node returns the
   parent's list with `up: 1` (parent seeded with `own('P1')`).
4. Marker alone (`[]`): stores `suggestions: []`; GET returns `[]` although the parent has items.
5. Keep: parent stores `own('Глава 4')`; the block copies `'Глава 4'` verbatim → stored
   `{ up: 1 }`, GET target = parent. Two levels: the grandparent offers X, the parent keeps it
   (stored `up: 1`), a child keeps it again → stored `up: 2`, target = grandparent. An edited copy
   (`'Глава 4!'`) is stored as a new own item.
6. Finalization: the question's own text, an empty string and duplicates in the block are dropped;
   ten distinct items are all stored (no cap).
7. Cancel while the block is withheld (step until the marker tokens were pushed, then
   `cancelQuestion`): no node is created (`demo.vfs.list(parentDir)` unchanged) and no chunk
   contained the block.
8. Failure then retry: `text: 'Please fail'` with a step function returning `['First']` for
   attempt 1 and `['Second']` for attempt 2. The failed entry's `live.answer` has no block; after
   retry the node stores `[{ text: 'Second', up: 0 }]` and `calls` has two inputs (attempt 1 and
   2, candidates recomputed).
9. Files-only message (`text: ''`, one file) with a block stores its items.
10. End to end with the default simulator (`makeDemo()` with constant 0.5): "Make a plan for
    ownership" → GET lists the three steps (plus nothing else); asking step 1 under the plan stores
    steps 2 and 3 with `up: 1`, the child's GET shows them inherited with target = plan, the plan's
    GET drops step 1 (used); asking step 2 under the plan leaves only step 3 inherited on the
    child. (Same expectations as today's end-to-end test.)

Existing tests that keep passing and now cover the block implicitly (constant 0.5 → the default
simulator appends a block): "streams contiguous chunks, then names and commits the node"
(`assistant === answer.trim()`), the citation tests (`assistant === streamed.trim()`, three
footnote definitions). Add to the citation test: `assistant` does not contain `<!--` and its last
line is a footnote definition.

### `demo/src/mock/demo.test.ts`

- Imports: drop `scriptedSuggest`.
- "stored suggestions stay out of other payloads": keep the chain and hierarchy cases. Replace
  "structural routes never get a 409 from a running suggestion generation" with "structural routes
  and suggestion reads never conflict": with a stored list on `a`, `getSuggestions` works while a
  question streams (no 409), and delete/restore/move/rename/title change succeed when no question
  runs, with `getSuggestions` following the new ids afterwards.

### `demo/src/mock/format.test.ts`

- Delete the `spliceSuggestions` case (and its import). Everything else unchanged.

### `demo/src/mock/seed.test.ts`

As described under Files.

### Not tested in the demo

Block grammar corner cases (fences, rejected markers, CRLF, chunk-split invariants): tested on the
server against the same pure module (`server/test/suggestion-block.test.ts`).
