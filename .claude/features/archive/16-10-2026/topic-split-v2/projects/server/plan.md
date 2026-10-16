# Server plan: topic-split-v2

Project `server` (`server/`, Node 22 / TypeScript / Fastify). Contract owner.
Contract: `.claude/features/topic-split-v2/contracts/` (base: archived `inline-suggestions` contract).

## Summary
- Mostly a prompt change: the "Big topics" section of `SYSTEM_RULES` now asks for a map only, every part (first included) in the block, plus one `- <!-- otago:whole --> <request>` item.
- The block grammar, the streaming filter and `splitSuggestionBlock` stay as they are. The special line is an ordinary item line, so it is withheld like the rest of the block.
- `finalizeSuggestions` reads the prefix and stores the item as `{ text, up: 1, kind: 'whole' }`, last in the list. It keeps the item only when the list also has at least two own regular items, and only the first one.
- `resolveSuggestions` sends `whole` to the viewed node's parent (`""` for a top-level map), only when the node has its own list (no inheritance). `pickCandidates` never offers it.
- No route, schema, lock, config, SSE or error change. Old nodes parse unchanged.

## Decisions (open questions owned by the server)
1. **Grammar: a prefix on the item line**, `- <!-- otago:whole --> Объясни главу 4 целиком, одним ответом, без разбиения`. A second marker line would break the block under today's grammar (a non-item line inside the block), so both the filter and the split would have to change, and a misplaced line would leak every part into the answer.
2. **"Whole" without a split: dropped.** Kept only when the finalized list has `>= MIN_SPLIT_PARTS` (2) own regular items (`up: 0`, no `kind`).
3. **Several "whole" items: the first accepted one wins**, the rest are dropped.
4. **Root target:** `""`. A question with `parentId: ""` already creates a top-level node, and `readChildQuestionKeys(treeDir, "")` already scans the top-level nodes for "used".
5. **Unknown `kind` values are dropped on read.** An unknown special item must never show up as a regular button. Other unknown keys are still ignored.

## Files to change

### 1. `server/src/storage/suggestion-block.ts` (pure, imports nothing)
Add:
- `export const WHOLE_ITEM_PREFIX = '<!-- otago:whole -->';`
- `export const WHOLE_ITEM_RE = /^<!--[ \t]*otago:whole[ \t]*-->[ \t]*(.*)$/;`
- `export type BlockItemKind = 'whole';`
- `export interface BlockItem { text: string; kind?: BlockItemKind }`
- `export function parseBlockItem(raw: string): BlockItem`: `{ text: m[1] ?? '', kind: 'whole' }` when the regex matches, else `{ text: raw }`.
- `export function wholeItem(text: string): string`: returns `` `${WHOLE_ITEM_PREFIX} ${text}` ``.
- Update the header comment to point at the new contract.

Do not touch `LineMachine`, `SuggestionBlockFilter`, `splitSuggestionBlock`, `suggestionBlock` or the regexes. `SplitAnswer.items` stays raw strings.

### 2. `server/src/storage/suggestions.ts` (pure; imports `../text.js` and now `./suggestion-block.js`)
- `import { type BlockItemKind, parseBlockItem } from './suggestion-block.js';` (no cycle: `suggestion-block.ts` imports nothing). Both modules are re-exported by `storage/index.ts` with `export *`, so do not declare `BlockItemKind` a second time here. Re-use the imported type.
- `StoredSuggestion` gets `kind?: BlockItemKind`. `Suggestion` gets `kind?: BlockItemKind`. Update the doc comment on `target` (it may be `""` for `whole`).
- `export const MIN_SPLIT_PARTS = 2;`
- Private helper `wholeTarget(chain, stored)`: returns `stored >= 1 ? chain[stored - 1].id : ''`.
- `parseStoredSuggestions`, after today's checks:
  - `kind === undefined`: push `{ text, up }`.
  - `kind === 'whole' && up === 1`: push `{ text, up: 1, kind: 'whole' }`.
  - Anything else: skip the item.
  - Use `'kind' in item ? item.kind : undefined`, so an explicit `kind: undefined` counts as absent.
- `suggestionsLine`: map each item to `kind ? { text, up, kind } : { text, up }` (keeps this key order, writes no other keys).
- `suggestionTargets`: in the loop, a `whole` item adds `wholeTarget(chain, stored)` only when `stored === chain.length - 1`, then `continue`. Other items are unchanged.
- `resolveSuggestions`: at the top of the loop, before the `item.up > 0` branch, handle `item.kind === 'whole'`:
  - skip it if `shift > 0` or a whole item was already emitted;
  - `target = wholeTarget(chain, stored)`;
  - run the shared `seen` dedupe, then the `usedKeysByTarget.get(target)` check;
  - push `{ text, target, up: 1, kind: 'whole' }`.
  - Skip the `below` filter (it only applies when `shift > 0`).
- `pickCandidates`: add `.filter((item) => item.kind === undefined)` before the `askedKeys` filter.
- `finalizeSuggestions`: same signature.
  - For each raw text: `const { text: rawText, kind } = parseBlockItem(raw)`, then sanitize.
  - `kind === 'whole'`: the item is `{ text, up: 1, kind: 'whole' }`. Skip the candidate lookup. Drop it if a whole item was already accepted.
  - The `askedKeys` drop and the key dedupe stay as they are and apply to whole items too.
  - Result: `[...own, ...kept, ...(whole && own.length >= MIN_SPLIT_PARTS ? [whole] : [])]`. `own` and `kept` exclude items with a `kind`.
- Update the header comment (contract path).

### 3. `server/src/storage/node-suggestions.ts`
- No code change. `readUsedKeys` already handles `""`. `readCandidates` gets the extra target from `suggestionTargets`, which costs one directory scan. Update the header comment (contract path) only.

### 4. `server/src/storage/format.ts`
- No code change (it goes through `parseStoredSuggestions` / `setSuggestionsLine`). Check that `NodeFile.suggestions` uses the updated `StoredSuggestion` type.

### 5. `server/src/questions/runner.ts`
- No logic change. `finalizeSuggestions(split.items, candidates, …)` already gets the raw items with the prefix, and `createNode` writes what it returns. Optional: one comment line next to the call ("`whole` items are classified by finalization").

### 6. `server/src/agent/prompt.ts`
- Import `WHOLE_ITEM_PREFIX` from `../storage/index.js`, next to `SUGGESTIONS_MARKER`.
- Replace the "Big topics" section with the text below (it must stay one paragraph-block with no blank line inside, because the tests slice up to `\n\n`; it must contain no digits).
- "Next questions" first bullet: `the remaining parts of a split topic` becomes `the parts of a split topic`.

New "Big topics" section (template literal, so `${WHOLE_ITEM_PREFIX}` interpolates):

```
Big topics:
- If the question covers more than one answer can explain in full detail (for example a chapter made of several substantial parts), split it: do not compress it and do not cover everything at once.
- A split answer is only the map: say in a short sentence that the topic is big, then name each part in one line, in the order to learn them. Explain no part, give no examples and ask no check-your-understanding question in it; you may cite where each part is in the sources.
- End the map with a next-questions block: one request per part, the first part included, in the order of the map, each naming its part clearly enough to make sense on its own (for example "Explain the first part of the chapter: ownership", in the language of your answer).
- The last line of that block asks for the whole topic in one answer, without splitting, worded as the learner would send it in the language of your answer, and starts with this mark:
  - ${WHOLE_ITEM_PREFIX} Explain the whole chapter in one answer, without splitting it
  Write this line only when you split, only once, and only in the block of the map. Never copy it from <open-suggestions>.
- When the question is one of those parts, explain that part in full. Parts of the same topic that are still not covered come back in <open-suggestions>: if you write a block, copy them into it word for word, so the rest of the map stays offered.
- A part that is still too big is split again the same way: its answer is a map of its own parts, with its own whole-topic line.
- If the learner asks for a short overview or for everything in one answer, answer in one message without splitting.
```

Notes for the implementer:
- The example line is indented with two spaces like the marker example in "Next questions". It must not start with `<!-- otago:suggestions -->`, so the prompt contains no fake block.
- Rule 5 ("check understanding with a short question at the end") is overridden for maps by the second bullet. Do not edit rule 5.
- Do not hand-format. Run `pnpm format` / `pnpm check` after editing.

### 7. `server/scripts/ask.ts`
- No code change: `--- suggestions block:` prints the raw items (prefix visible) and `--- suggestions stored:` prints the JSON with `kind`. Optional: update the header comment.

### 8. Docs
- Root `CLAUDE.md`:
  - "Topic split" bullet: now `.claude/features/topic-split-v2/`. The map answer explains nothing, every part is in the block, and a `<!-- otago:whole -->` item becomes `{ text, up: 1, kind: 'whole' }` (≥ 2 own parts required, first wins). It resolves to the parent (`""` = root), is not inherited and is never a candidate.
  - "Suggestions" bullet: mention the optional `kind`.
  - Web and demo bullets are updated by their own plans.
- `.claude/features/topic-split-v2/feature.md`: open questions 1 and 4 are answered (the feature workflow updates it).

## Data model changes
- `node.md` frontmatter `suggestions:` items may carry `"kind":"whole"` (always with `"up":1`, at most one, last). Optional key; nodes without it serialize byte-identically to today. No migration.
- No new frontmatter key, no new files or folders.

## Interface changes
- `GET /api/trees/:tree/suggestions` items: optional `kind: 'whole'`, `target` may be `""` for such an item. Envelope, status table and lock behaviour are unchanged.
- No other HTTP, SSE, CLI or agent-interface change.

## Step order
1. `suggestion-block.ts`: prefix constant, regex, `parseBlockItem`, `wholeItem`, plus unit tests.
2. `suggestions.ts`: types, `MIN_SPLIT_PARTS`, reader and writer, then `finalizeSuggestions`, `resolveSuggestions`, `suggestionTargets`, `pickCandidates`, plus unit tests.
3. Run the existing suggestion test suites (`suggestions-format`, `suggestion-block`, `questions-suggestions`, `suggestions-api`) and fix the one expected break (see below).
4. Integration tests in `questions-suggestions.test.ts`.
5. `prompt.ts` section plus `agent.test.ts`.
6. Comments and docs (`CLAUDE.md`), then `pnpm format`, `pnpm lint`, `pnpm test` (all packages: the demo imports the changed pure modules, so its tests must still pass before its own plan lands).

## Test plan (vitest; `test/helpers.ts`; no real SDK calls)

### `test/suggestion-block.test.ts` (new `describe('whole item')`)
- `parseBlockItem`:
  - plain text gives `{ text }`;
  - `<!-- otago:whole --> X` gives `{ text: 'X', kind: 'whole' }`;
  - spacing variants (`<!--otago:whole-->X`, tabs) are accepted;
  - a different case (`otago:Whole`) and a prefix in the middle of the text stay plain;
  - the prefix alone gives `{ text: '', kind: 'whole' }`.
- `wholeItem` + `suggestionBlock` round trip: `splitSuggestionBlock(answer + suggestionBlock(['A', 'B', wholeItem('W')]))` gives `items` equal to `['A', 'B', '<!-- otago:whole --> W']` and an unchanged answer.
- Streaming: for every chunking of a map answer ending in a block with a whole item, the concatenated filter output equals the answer without the block and never contains `otago:whole` (extend the existing every-split helper with this fixture).
- A standalone `<!-- otago:whole -->` line inside a block: rejected (`rejected: true`, `items` undefined, text kept). This documents the strict grammar.

### `test/suggestions-format.test.ts`
- `parseStoredSuggestions`:
  - `{ text, up: 1, kind: 'whole' }` is kept;
  - `kind: 'whole'` with `up: 0` / `2` is dropped;
  - `kind: 'extra'`, `kind: 5` and `kind: null` are dropped;
  - `kind: undefined` gives a regular item;
  - other unknown keys are still ignored.
  - **Expected break:** the existing case `{ text: '  a\nb ', up: 0, kind: 'extra' }` currently expects `{ text: 'a b', up: 0 }`. Change it to an unknown key such as `extra: 'x'` (same expectation) and move `kind: 'extra'` into the new "dropped" assertions.
- `suggestionsLine`: a whole item writes `{"text":"W","up":1,"kind":"whole"}`; extra keys are still not written; a list without kinds is byte-identical to today; the node.md round trip with a whole item works.
- `finalizeSuggestions`:
  - `['A', 'B', wholeItem('W')]` gives `[A up0, B up0, W up1 whole]`;
  - the whole item written first in the block is still stored last;
  - one own item plus whole gives no whole;
  - two own items plus kept candidates plus whole gives `own, kept, whole`;
  - kept candidates do not count as parts (one own plus two kept plus whole gives no whole);
  - two whole items: the first wins;
  - a whole whose text equals a candidate text is not a keep (whole, `up: 1`; dedupe still applies if the same key also appears as a regular item earlier);
  - a whole whose key is in `askedKeys` is dropped;
  - an empty whole text is dropped;
  - a block with only a whole item gives `[]`.
- `resolveSuggestions`:
  - top-level map `[A, B, W]` gives a whole target of `''`, `up: 1`, `kind: 'whole'`, last;
  - nested map under `p` gives target `p`;
  - a child without a list (fallback) never shows whole;
  - "used": a live child of the parent asking W hides it (`usedKeysByTarget` keyed `''` / `p`);
  - two stored whole items: only the first is shown;
  - a whole item never goes through owner validation (the parent has no list: still shown).
- `suggestionTargets`: includes `''` / the parent id for a map's own list; excludes it on the fallback (child without a list).
- `pickCandidates`: the map's chain as ancestors never yields the whole text.

### `test/questions-suggestions.test.ts` (fakeAgent / `scriptedAgent`, `makeApp`, `askAndSettle`)
- **Top-level map (S1):**
  - an agent answering `'The topic is big. Map…'` with `suggestionBlock(['Part one', 'Part two', 'Part three', wholeItem('Whole chapter in one answer')])`;
  - the saved node.md has the three parts with `up: 0` and the whole item with `up: 1, kind: 'whole'`;
  - no chunk and no `live.answer` snapshot contains `otago` or the whole text;
  - the naming input has no block;
  - GET for the map node returns the three parts targeting the map and `{ text, target: '', up: 1, kind: 'whole' }` last.
- **Pick a part (S2):**
  - the child is asked from the map with an agent that writes no block;
  - `agent.calls[n].openSuggestions` lists the parts other than the asked one and **not** the whole text;
  - GET for the child shows the remaining parts with `up: 1` and no whole item;
  - the map's GET hides the asked part and still shows whole.
- **Explain it whole (S3):**
  - `askAndSettle(ctx, { parentId: '', text: <whole text> })` creates a top-level node (a sibling of the map);
  - afterwards GET for the map no longer contains the whole item ("used" under `''`), while the parts are still there.
- **Nested map:** map node `p/map` (hand-written parent `p` with `writeNode`); GET gives the whole target `p`. After the map is moved under another parent via the existing move route, the target follows the new parent.
- **Whole without a split:** a block with one regular item plus a whole item stores only the regular item.
- **Cancel / failure mid-block with a whole item:** reuse the existing cancel test with a whole line in the block: no node, and no chunk contains `otago:whole`.

### `test/agent.test.ts`
- Rewrite "splits a big topic…" as "splits a big topic: map only, every part and a whole-topic item as next questions":
  - the section is present before "Next questions:";
  - it contains `'only the map'`, `'Explain no part'`, `'one request per part, the first part included'`, `WHOLE_ITEM_PREFIX`, `'only when you split'`, `'<open-suggestions>'`, `'word for word'`, `'split again'`, `'without splitting'`;
  - it does not contain `'only the first part, in full detail'` or `'one request per remaining part'`;
  - it does not match `/\d/`;
  - it does not contain `SUGGESTIONS_MARKER`.
- `SYSTEM_RULES` contains `'the parts of a split topic'`. The existing "Next questions" test (marker, no digits) stays green.

### `test/suggestions-api.test.ts`
- Hand-written top-level map with a stored whole item: 200 `ready`, the whole item has target `''`. A stored item with an unknown `kind` is not in the response.

## Risks and notes
- The model may write the whole line without the bullet (standalone comment line). The block is then rejected and stays in the answer (warning logged), same as any malformed block today. The prompt shows the exact bullet form. Check with `pnpm --filter @otago/server ask <tree> "Разбери главу 4"` on a real tree: the stored JSON must show `kind: 'whole'`.
- The demo imports `suggestions.ts` and `suggestion-block.ts` by file. Both stay Node-free (the new import between them is pure). The demo's seed invariant test ("an inherited item's text equals an own item of its owner") must skip `kind` items; that is demo-plan work.
- The web mirrors `Suggestion.kind` and must not drop `whole` in its "own beats inherited" dedupe (`up: 1`). That is web-plan work, noted in `contracts/suggestions-api.ts`.
