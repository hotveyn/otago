# Demo plan: topic-split-v2

Project `demo` (`demo/`, browser-only mock backend for the web UI, TypeScript, Vite, Vitest). Client of the server-owned contract `.claude/features/topic-split-v2/contracts/`. No web change is needed here: the Vite shim swaps `web/src/api/client.ts` for `demo/src/mock/client.ts`, and the button itself is web-plan work.

## Summary
- Storage, resolution, candidates and finalization of the "whole" item come for free from the server's pure modules (`server/src/storage/suggestion-block.ts`, `server/src/storage/suggestions.ts`). The demo imports them and duplicates nothing: `wholeItem`, `parseBlockItem`, `MIN_SPLIT_PARTS`, `finalizeSuggestions`, `resolveSuggestions`, `suggestionTargets`, `pickCandidates`, `parseStoredSuggestions`, `suggestionsLine`.
- The block simulator (`mock/suggestions.ts`) now produces split answers. A big-topic question gets every part as an own item (the first part included), then the open suggestions, then one `wholeItem(...)`. A part question keeps the open suggestions as before. A request for everything in one answer is never split.
- The runner sim (`mock/questions.ts`) writes a map-only answer when the finalized block keeps a `whole` item. The answer is a short "this topic is big" sentence plus the numbered parts, with no explanation, example or exercise. Otherwise it writes Lorem ipsum as today.
- Seed: a new top-level map node `chapter-4` stores three parts and a `whole` item (target `""`, the tree root). Its part child `chapter-4/what-ownership-is` has no list of its own, so it inherits parts two and three but not "whole".
- `seed.test.ts`: the inheritance invariant skips `kind` items, the order check allows `whole` only at the end, and a new showcase check covers the map node.
- `trees.ts`, `demo.ts`, `client.ts`, `connection.ts`: no code change. `usedKeys(tree, [''])` already scans the top-level nodes: `dirOf(tree, '')` is the tree folder, and `isReservedName('', …)` skips `sources/`.

## Prerequisite
Server steps 1–2 (`suggestion-block.ts`: `WHOLE_ITEM_PREFIX`, `WHOLE_ITEM_RE`, `BlockItemKind`, `parseBlockItem`, `wholeItem`; `suggestions.ts`: `kind` on `StoredSuggestion` / `Suggestion`, `MIN_SPLIT_PARTS`, reader/writer/resolve/targets/candidates/finalize). These are already in the working tree. Both modules must stay Node-free, and the demo imports them by file, not through `storage/index.ts`.

As soon as the server reader drops unknown `kind` values, one demo test breaks: `format.test.ts` "drops invalid items, keeps the list stored and ignores unknown keys" uses `{ text: 'Good', up: 0, kind: 'future' }` and expects it kept. Step 1 fixes it.

## Files to change

### 1. `demo/src/mock/format.ts`
- No code change. It reads through `parseStoredSuggestions` and writes through `setSuggestionsLine`, and `NodeFile.suggestions` uses the server's `StoredSuggestion`, which now has `kind`.
- Header comment: add `topic-split-v2/contracts/node-file.ts` (optional `kind: 'whole'`, written as `{ text, up, kind }`).

### 2. `demo/src/mock/suggestions.ts` (pure; no I/O, no timers)
Header: contract `.claude/features/topic-split-v2/contracts/agent.ts`, "Big topics". The simulator reproduces the observable output: map answers with every part plus one whole item.

New imports:
- `wholeItem` from `../../../server/src/storage/suggestion-block`
- `type StoredSuggestion` from `../../../server/src/storage/suggestions`

Constants (they replace `PLAN_RE` / `STEP_RE`):
- `BIG_TOPIC_RE = /\b(plan|steps?|chapters?|roadmap|outline)\b/i`. This is today's `PLAN_RE`, renamed: such a question is too big for one answer.
- `PART_RE = /^Explain (part \d+ of .+)$/`. These are our own part texts. Asking one does not split again (it replaces `STEP_RE`), and group 1 is the topic used for templates.
- `WHOLE_TEXT_RE = /^Explain all of (.+) in one answer, without splitting it$/`. This is our own whole text; group 1 = the topic.
- `WHOLE_REQUEST_RE = /\b(?:in one answer|without splitting|all at once)\b/i`. It marks an explicit "everything in one answer" request, which is never split. It is checked before `BIG_TOPIC_RE`, so the whole text, which may name a chapter, does not split again.
- `export const SPLIT_PARTS = 3` (deterministic, no random draw, like today's three steps).

New exported pure helpers:
- `partText(topic, n)` returns `` `Explain part ${n} of ${topic}` ``.
- `wholeText(topic)` returns `` `Explain all of ${topic} in one answer, without splitting it` ``.
- `splitParts(finalized: readonly StoredSuggestion[]): string[] | undefined`
  - Returns `undefined` when no item has `kind === 'whole'` (not a map).
  - Otherwise returns the texts of the own regular items (`up === 0`, no `kind`), in order.
  - The server's `MIN_SPLIT_PARTS` rule inside `finalizeSuggestions` decides whether `whole` survives. The demo does not re-check it.
- `mapAnswer(parts: readonly string[]): string`. The map-only answer, deterministic:
  ```
  This topic is too big for one answer, so here is a map of its parts. Learn them in this order.

  1. <label 1>
  2. <label 2>
  …

  Pick a part below to start, or ask for all of it in one answer.
  ```
  - `label` = the part text without a leading `Explain `, first letter upper-cased.
  - It explains no part, has no code, no exercise and no block marker.
  - It has three prose sentences, so `withCitations` (`cite.ts` skips list lines) has places for chips.

`suggestionTopic(question)`:
- A first line matching `PART_RE` uses group 1 (`part 1 of ownership`), as `STEP_RE` did.
- A first line matching `WHOLE_TEXT_RE` uses group 1 (`ownership`).
- Otherwise, unchanged.

`simulateSuggestionBlock(random)`, decision order:
1. First line matches `PART_RE`: return `openSuggestions.length > 0 ? [...openSuggestions] : undefined`. A part answer keeps the uncovered parts word for word. The `whole` item is never among them, because `pickCandidates` filters it out.
2. `BIG_TOPIC_RE.test(question) && !WHOLE_REQUEST_RE.test(question)`: return `[partText(topic, 1), …, partText(topic, SPLIT_PARTS), ...openSuggestions, wholeItem(wholeText(topic))]`. No random draw.
3. Otherwise, the random branch is unchanged (no block / marker alone / templates plus kept items). It never writes a whole item, and this is where a whole request lands.

Parts never split again in the default simulator (step 1 comes first). Nested maps are covered by a scripted test (see the test plan).

`BlockSimulator`, `SimulatedBlockInput` and `DemoOptions.suggest` are unchanged. Scripted steps carry the prefix through `wholeItem(...)`.

### 3. `demo/src/mock/questions.ts` (runner sim)
- Imports: add `splitParts` and `mapAnswer` from `./suggestions`. `finalizeSuggestions` is already imported.
- `run(entry)`: the body is chosen after the simulator runs, because a real model decides to split before it writes.
  ```
  state  = this.suggestionState(...)                      (unchanged)
  lorem  = loremAnswer(this.random)
  texts  = this.suggest({...})                             (same input as today)
  parts  = texts && splitParts(finalizeSuggestions(texts, state.candidates,
                                { depth: state.depth, askedKeys: state.askedKeys }))
  answer = withCitations(parts ? mapAnswer(parts) : lorem, this.citeRefs(entry), this.random)
  raw    = answer + (texts ? suggestionBlock(texts) : '')
  ```
  - The order of random draws changes: the simulator now draws before the citations. All Questions tests use a constant `random`, so nothing depends on the order. Update the "Asked after the answer…" comment to say the simulator is asked after the Lorem body.
  - The early `finalizeSuggestions` call only classifies. The commit still finalizes `splitSuggestionBlock(raw.trim()).items`, which stays the single source of truth for what is stored. For single-line texts the two inputs give the same result.
- `commit`: no change. `createNode` stores the `{ text, up: 1, kind: 'whole' }` item, last, through `setSuggestionsLine`.
- The streaming filter is unchanged: the `- <!-- otago:whole --> …` line is an ordinary block line and is withheld with the rest of the block.
- Header comment: add contract `topic-split-v2` (map answers, whole item).

### 4. `demo/src/mock/trees.ts`
- No code change. `suggestionsView` / `suggestionCandidates` go through the server's `suggestionTargets` / `resolveSuggestions` / `pickCandidates`: whole items target the parent (`''` at top level), are not inherited and are never candidates.
- Update the section comment to `inline-suggestions` + `topic-split-v2`.

### 5. Seed: new nodes in `demo/seed/rust-ownership/`
No PDF changes (the seed PDFs stay pure ASCII/LF). Node files are UTF-8 Markdown with LF endings, and no stored answer contains a block or `otago:whole`.

`chapter-4/node.md`: a top-level map. Use `created: 2026-09-20T10:30:00.000Z`, after `stack-and-heap`. The suggestions line is in exact write form, one line, key order `text, up[, kind]`:
```
---
created: 2026-09-20T10:30:00.000Z
model: claude-opus-5-5
suggestions: [{"text":"Explain the first part of chapter 4: what ownership is","up":0},{"text":"Explain the second part of chapter 4: references and borrowing","up":0},{"text":"Explain the third part of chapter 4: mutable and dangling references","up":0},{"text":"Explain all of chapter 4 in one answer, without splitting it","up":1,"kind":"whole"}]
---
<!-- otago:user -->
Walk me through chapter 4 of the Rust book

<!-- otago:assistant -->
Chapter 4 is too big for one answer, so here is its map. It has three parts, in the order to learn them:

1. **What ownership is**: the three rules and how a `String` frees its memory[^1].
2. **References and borrowing**: using a value without taking ownership of it[^2].
3. **Mutable and dangling references**: the one-writer rule and references that outlive their value[^3].

Pick a part below to start, or ask for the whole chapter in one answer.

[^1]: sources/rust-book-ch04-ownership.pdf:2 (4.1 What Is Ownership?)
[^2]: sources/rust-book-ch04-ownership.pdf:3 (4.2 References and Borrowing)
[^3]: sources/rust-book-ch04-ownership.pdf:4 (mutable and dangling references)
```
- The PDF has 4 pages: p1 contents, p2 4.1, p3 4.2, p4 mutable/dangling.
- No chip comes right before a colon.

`chapter-4/what-ownership-is/node.md`: a part child.
- `created: 2026-09-20T10:36:00.000Z`, and **no `suggestions:` key**.
- Its `user` is exactly the first part's text (`Explain the first part of chapter 4: what ownership is`), so that part is "used" under `chapter-4`.
- The answer explains part one in full: the three rules, a short `String` scope example and one exercise (per `tree.md`). It cites `sources/rust-book-ch04-ownership.pdf:2` and `sources/rust-ownership-notes.md:5-9`.

The resulting views:

| Node | Suggestions |
|---|---|
| `chapter-4` | part two and part three (target `chapter-4`, `up: 0`), then `{ text: 'Explain all of chapter 4 in one answer, without splitting it', target: '', up: 1, kind: 'whole' }` |
| `chapter-4/what-ownership-is` | fallback: part two and part three (target `chapter-4`, `up: 1`), no whole item |

Do not bump `VFS_STORAGE_KEY`. The new nodes reach new visitors and anyone who presses Reset, the same as earlier seed changes.

### 6. `demo/src/mock/test-helpers.ts`
- No change is required: `NODE(user, created, suggestions)` writes through the server's `suggestionsLine`, which emits `kind`. `scriptedBlocks` passes texts through, and steps use `wholeItem(...)`.
- Optional: export a `WHOLE = (text) => ({ text, up: 1, kind: 'whole' as const })` builder for stored items in tests.

### 7. Docs
Root `CLAUDE.md`, Demo "Suggested prompts" bullet:
- Add the contract `topic-split-v2`.
- The simulator splits big-topic questions: every part as an own item, then the open suggestions, then `wholeItem(...)`.
- The runner writes `mapAnswer(parts)` when the finalized list keeps a whole item.
- "In one answer" requests are never split, and part questions keep the open suggestions.
- Seed map node `chapter-4` (whole target = root) with a part child that inherits without whole.
- `seed.test.ts` skips `kind` items in the inheritance invariant.

The server and web bullets belong to their own plans.

## Data model changes
None of the demo's own. The VFS `node.md` files may now carry `"kind":"whole"` items, written by the server's pure writer, so the bytes match the server's. The localStorage key and VFS format are unchanged.

## Interface changes
- `api.getSuggestions` (mock) may return items with `kind: 'whole'` and `target: ''`, exactly as the server does. This comes from `resolveSuggestions`.
- Until the web plan adds `kind` to `web/src/api/types.ts`, the extra optional key still type-checks (`trees.suggestionsView` returns a non-literal object).
- `api.startQuestion` with `parentId: ''` already creates a top-level node.
- Nothing is added to the shim's exports.

## Step order
1. Fix the expected break in `format.test.ts` and add the `kind` read/write cases (below). Run `pnpm --filter @otago/demo test` against the server's new pure modules.
2. `mock/suggestions.ts`: constants, `partText`, `wholeText`, `splitParts`, `mapAnswer`, `suggestionTopic`, `simulateSuggestionBlock`, plus unit tests in `suggestions.test.ts` (rewrite the plan/step cases).
3. `mock/questions.ts`: choose the body in `run`, plus tests in `questions.test.ts` (rewrite the default-simulator end-to-end test).
4. GET and candidate tests for whole items in `suggestions.test.ts`.
5. Seed nodes, then the `seed.test.ts` changes.
6. Header comments, root `CLAUDE.md` Demo bullet.
7. `pnpm format` (never hand-format), `pnpm --filter @otago/demo lint`, `pnpm --filter @otago/demo test`, then `pnpm test`.
8. Manual check with `pnpm demo`:
   - Ask "Make a plan for ownership": a map answer with three part buttons plus "explain it whole" (generic until the web plan lands).
   - Pick a part: no whole button on it.
   - Click whole: a new top-level node, after which the button disappears from the map.
   - Reset and open `chapter-4`.

## Test plan (Vitest, fake timers, `makeDemo` / `scriptedBlocks`; `random: () => 0.5`)

### `src/mock/format.test.ts`
- **Fix** "drops invalid items, keeps the list stored and ignores unknown keys":
  - Replace `{ text: 'Good', up: 0, kind: 'future' }` with `{ text: 'Good', up: 0, extra: 'future' }` (still expected `{ text: 'Good', up: 0 }`).
  - Add dropped items: `{ text: 'F', up: 0, kind: 'future' }`, `{ text: 'N', up: 0, kind: null }`, `{ text: 'W0', up: 0, kind: 'whole' }`, `{ text: 'W2', up: 2, kind: 'whole' }`.
  - Add a kept item: `{ text: 'W', up: 1, kind: 'whole' }` gives `{ text: 'W', up: 1, kind: 'whole' }`.
- **New** "writes and reads a whole item in the server's form":
  - `serializeNodeFile({ ...base, suggestions: [{ text: 'P', up: 0 }, { text: 'W', up: 1, kind: 'whole' }] })` equals `withLine('suggestions: [{"text":"P","up":0},{"text":"W","up":1,"kind":"whole"}]')`.
  - It parses back equal.
  - A list without kinds is unchanged (the existing tests stay green).

### `src/mock/suggestions.test.ts`, `describe('default block simulator')`
- **Rewrite** "plan-like questions get three steps…" as "big-topic questions get every part, then the open suggestions, then one whole item": `input('Make a plan for ownership')` gives `['Explain part 1 of ownership', 'Explain part 2 of ownership', 'Explain part 3 of ownership', 'B', 'C', wholeItem('Explain all of ownership in one answer, without splitting it')]`. The same holds for any `random` (no draw).
- **Rewrite** "a step question…" as "a part question keeps exactly the open suggestions; none → no block": `Explain part 1 of ownership` with `['B', 'C']` gives `['B', 'C']`; with `[]` it gives `undefined`. Also check that a part whose topic names a chapter (`Explain part 2 of chapter 4`) is not split.
- **New** "a request for everything in one answer is never split":
  - `wholeText('chapter 4')` and `'Make a plan for ownership, all at once'` with `random = () => 0.5` give template items plus the open suggestions.
  - No item has `parseBlockItem(item).kind === 'whole'`.
  - Templates use the topic `chapter 4`.
- `suggestionTopic`: `Explain part 1 of ownership` gives `part 1 of ownership`; `wholeText('ownership')` gives `ownership`. The existing cases stay.
- The determinism test stays.
- **New** `splitParts` / `mapAnswer`:
  - `splitParts` of `[P1 up0, P2 up0, K up1, W up1 whole]` gives `['P1', 'P2']`; without a whole item it gives `undefined`.
  - `mapAnswer(['Explain part 1 of x', 'Explain part 2 of x'])` contains `1. Part 1 of x` and `2. Part 2 of x` in order and starts with the "too big" sentence.
  - It contains no `<!--`, and `splitSuggestionBlock(mapAnswer(…)).items` is `undefined`.

### `src/mock/suggestions.test.ts`, `describe('suggestions: GET')`
- **New** "a map's whole item targets its parent, is last, never inherited and hides once used". Seed:
  - `t/m/node.md` with `[P1 up0, P2 up0, W up1 whole]`;
  - `t/m/p/node.md` = `NODE('P1', …)` without a list;
  - nested `t/a/n/node.md` with `[Q1, Q2, W2 whole]`.
  - GET `m` gives `[{ P2, target 'm', up 0 }, { W, target '', up 1, kind 'whole' }]` (P1 is used).
  - GET `m/p` gives `[{ P2, target 'm', up 1 }]` (no whole).
  - GET `a/n` gives the whole target `a`.
  - After `demo.vfs.transaction(() => writeText('t/w/node.md', NODE('W', …)))` the whole item disappears from GET `m`; after `deleteNodes(['w'])` it comes back.
- **New** "the whole item follows a move": `moveNodes(['a/n'], 'c')`, then GET `c/n` gives the whole target `c`. Move it to the top level and the target is `''`.
- **New** "an unknown kind is never shown": a raw line `suggestions: [{"text":"X","up":0,"kind":"future"},{"text":"Y","up":0}]` gives only `Y`.

### `src/mock/suggestions.test.ts`, `describe('suggestions: candidates…')`
- **New** "never offers the whole item": for parent `m` with `[P1, P2, W whole]`, `ask(demo, 'm', 'Other?')` gives `script.calls[0].openSuggestions` equal to `['P1', 'P2']`.

### `src/mock/questions.test.ts`, `describe('simulated questions: suggestion block')`
- **New** "a split answer is only the map; parts are own items and the whole item is stored last":
  - Scripted `[['Part one', 'Part two', 'Part three', wholeItem('All of it in one answer')]]`, `ask('', 'Big?')`.
  - The stored list is the three parts `up: 0`, then `{ text: 'All of it in one answer', up: 1, kind: 'whole' }`.
  - The raw node.md line ends with `{"text":"All of it in one answer","up":1,"kind":"whole"}]`.
  - The assistant starts with `mapAnswer`'s first sentence and contains `1. Part one` … `3. Part three`.
  - No streamed chunk contains `otago` or `All of it` (checked tick by tick, as in "never shows the block while streaming", including `live.answer` of a snapshot).
  - GET gives the parts targeting the node, then `{ …, target: '', up: 1, kind: 'whole' }`.
- **New** "explain it whole asks the map's parent and hides the button":
  - Continue the map under `a` (`ask('a', 'Big?')`), then `ask('a', 'All of it in one answer')` with no block.
  - The new node id is `a/<name>`, a direct child of `a`: a sibling of the map, not a node under it.
  - The simulator call for it has `parentId: 'a'` and its `openSuggestions` never contains the whole text.
  - GET for the map drops the whole item and keeps the parts.
- **New** "a part does not get the whole item":
  - Under the map, `ask(map, 'Part one')` with no block.
  - The call's `openSuggestions` equals `['Part two', 'Part three']`.
  - GET for the part gives `Part two` and `Part three` with `up: 1`, target the map, no `kind`.
  - GET for the map hides `Part one` and still ends with whole.
- **New** "a whole item without a split is dropped and the answer is Lorem":
  - `[['Only part', wholeItem('W')]]` stores `[{ text: 'Only part', up: 0 }]`, and the assistant does not start with the map sentence.
  - Parent `a` with own `['P1', 'P2']` and a block `['New', 'P1', 'P2', wholeItem('W')]` stores `[New up0, P1 up1, P2 up1]`, with no whole item and no map: kept items are not parts.
- **New** "two whole items: the first wins": `['A', 'B', wholeItem('W1'), wholeItem('W2')]` stores whole `W1` only.
- **New** "nested map: the whole item targets the outer map": the map `big` under `a`, then a scripted map answer to `ask(big, 'Part one')` (`['Sub one', 'Sub two', wholeItem('All of part one')]`). GET for the inner map gives the whole target `a/big`; the parts target the inner map.
- **New** "cancel while a block with a whole item is withheld creates no node": reuse the cancel test with `[...items, wholeItem('W')]`.
- **Rewrite** "end to end with the default simulator: plan steps…" as "end to end with the default simulator: a plan is split into a map, parts are inherited without the whole item, the whole item asks the parent". With `makeDemo()` defaults:
  - `ask('', 'Make a plan for ownership')`: GET gives the three part texts (target the map, `up: 0`), then `{ text: wholeText('ownership'), target: '', up: 1, kind: 'whole' }`. The assistant starts with the map sentence.
  - `ask(map, part1)`: the stored list is `[part2 up1, part3 up1]`, and the part's inherited GET is part2 and part3, target the map.
  - The map's GET gives `[part2, part3, whole]`.
  - `ask(map, part2)`: the part's inherited GET gives `[part3]`.
  - `ask('', wholeText('ownership'))`: the node is top-level, its assistant does not start with the map sentence (never split), and its stored items have no `kind`.
  - The map's GET gives `[part3]`.
- Existing tests ("strips the block…", "no block…", "marker alone…", keeps, failures, files-only) stay green unchanged. Their blocks have no whole item, so the body stays Lorem.

### `src/mock/seed.test.ts`
- "stores suggestions in the exact write form, sanitized, own first": extend the order check.
  - Regular items: own (`up 0`) first, then `up > 0`.
  - Items with a `kind`: only `whole`, at most one, last, `up === 1`.
  - `setSuggestionsLine(raw, stored)` must still equal `raw`, which proves the key order `text, up, kind`.
- "every inherited seed suggestion points at an ancestor that owns the text": `if (item.up === 0 || item.kind !== undefined) continue;`.
- **New** "showcases a map node: parts, an explain-it-whole item to the parent, a part child without it":
  - At least one node stores a whole item. Each such node has at least `MIN_SPLIT_PARTS` own regular items, and its view ends with `{ kind: 'whole', up: 1, target: <parent id or ''> }`.
  - Exact: `suggestionsView('rust-ownership', 'chapter-4').suggestions` equals the second and third part (target `chapter-4`, `up 0`), then the whole item with target `''`.
  - `suggestionsView(…, 'chapter-4/what-ownership-is')` has no own list and equals the second and third part with `up: 1`, target `chapter-4`, and no item with a `kind`.
  - No view anywhere in the seed has a whole item with `up !== 1` or on a node without its own stored whole.
- "stored seed answers never contain a suggestion block": also `not.toContain('otago:whole')`.
- The existing showcase counters (fallback, none, empty, deep, hiddenAsUsed) and the borrowing-rules fallback test stay as they are. The new nodes only add to them.
- The citation check covers the new nodes automatically: PDF pages 2–4 lie within 4 pages, and notes lines 5–9 lie within 41 lines.

## Risks and notes
- The web package may not render `kind: 'whole'` specially until its own plan lands. Until then the item shows as an ordinary button and still sends correctly (`parentId: ''` or the parent). The demo needs nothing from the web plan.
- The default simulator decides "split" from keywords only (`plan`, `chapter`, `outline`, …). This is a demo stand-in, not the real model. "In one answer" / "without splitting" / "all at once" always win, so the "explain it whole" click never produces another map.
- The changed order of random draws in `run` only affects non-constant `random` sources (the browser's `Math.random`). No test depends on it.
