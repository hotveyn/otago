# Server plan: inline suggestions

Contract: `.claude/features/inline-suggestions/contracts/` (owner: server). Base: the archived
`suggested-prompts` contract; the new files state what changes. Read `block.ts`, `suggestions.ts`
and `agent.ts` first.

## Summary of decisions

| Question | Decision |
|---|---|
| 1. Marker syntax | One line `<!-- otago:suggestions -->` followed only by item lines (`- text`, also `*`, `+`, `•`, `1.`, `1)`) and blank lines up to the end of the answer. No closing marker. Marker lines inside fenced code never count. A marker followed by any other line is ordinary answer text and stays in the answer (never cut out). |
| 2. Candidates to the agent | Static rules in `SYSTEM_RULES`; the parent's still-open suggestions as `<open-suggestions>` (`- text` lines, no numbers, no owner) in the user prompt right after `</transcript>`. Keep = copy the text verbatim; the server maps a text equal (by `suggestionKey`) to a candidate back to that candidate's owner. Anything else is a new own item. No block = candidates stay visible through inheritance. |
| 3. GET `missing` | Removed. Response shape kept, `state` is always `'ready'`. A node without a stored list resolves to its nearest stored ancestor's list (E1), `[]` when there is none. |
| 4. `pnpm ask` | Streams through the same filter, then prints the open suggestions offered, the raw block items, the finalized items (or "none (no block)") and a warning for a rejected marker. Still writes nothing. |
| Cap | None anywhere: `MAX_SUGGESTIONS` is removed. |
| Writer | Only `createNode` at the commit. The `Suggestions` service, lazy POST, adoption, verified later write, `OTAGO_SUGGEST_MODEL` and `agent.suggest` are deleted. |
| Logging | `warn` only for a rejected marker (and for a failed candidates read). No block is the normal case and is not logged. |
| Empty answer after stripping | The attempt fails as `agent_error` 'Agent returned an empty answer'. |

## Files

### New

- `server/src/storage/suggestion-block.ts`: pure, Node-free (imports nothing, or only
  `./suggestions.js` / `../text.js`). The demo imports it as-is. Exports:
  - `SUGGESTIONS_MARKER`, the line regexes (`MARKER_LINE_RE`, `ITEM_LINE_RE`, blank, fence
    open/close, same fence rule as `removeFencedBlocks` in `agent/prompt.ts`; copy the two fence
    regexes and do not import from `agent/`, so the module stays Node-free).
  - An internal line state machine (`fence`, `blockStart`, `rejected`) that both functions below
    use (contract `block.ts`, "GRAMMAR").
  - `class SuggestionBlockFilter { push(chunk): string; end(): string }` (streaming, contract
    holding rules). It keeps the current line's text for classification, separately from the
    held output buffer. Normal mode holds only an incomplete line whose `trimStart()` is a prefix
    of `<!--` or starts with it. Block mode holds everything. When a block breaks, it emits the
    held text before the breaking line, then processes that line as a normal one.
  - `splitSuggestionBlock(text): SplitAnswer` (`{ answer, items?, rejected }`). Implemented by
    running the same machine over the whole text (for example with a filter instance plus a
    record of where the marker line started), so the final split and the stream can never
    disagree.
  - `suggestionBlock(texts): string`: writer for tests and the demo simulator.
- `server/test/suggestion-block.test.ts` (see Test plan).

### Changed

- `server/src/storage/suggestions.ts` (pure, stays Node-free):
  - Header comment: point to `.claude/features/inline-suggestions/contracts/`.
  - Remove `MAX_SUGGESTIONS`, `SuggestPick`, `SuggestionsMissing`; make `SuggestionsResponse =
    SuggestionsReady`.
  - `SuggestionChainNode` gains `user: string` (server `ChainNode` already has it).
  - `suggestionTargets(chain)`: use the effective list at `nearestStoredIndex(chain)` (contract).
  - `resolveSuggestions(chain, used): Suggestion[]`: never `'missing'`, ancestor fallback with
    `shift` and the `below` asked-filter, no cap (contract pseudo-code).
  - `pickCandidates(ancestors, used, askedKeys)`: `resolveSuggestions(ancestors, used)` minus
    `askedKeys`, `origin = ancestors.length - 1 - item.up`. Drop the old nearest-index slicing.
  - `finalizeSuggestions(texts: readonly string[], candidates, ctx)`: texts in; a text whose key
    equals a candidate becomes a keep (`up = depth - origin`, `up < 1` dropped); otherwise a new
    own item. Asked items and duplicates are dropped; own items first; no cap.
  - Keep `sanitizeSuggestionText`, `suggestionKey`, `parseStoredSuggestions`, `suggestionsLine`,
    `setSuggestionsLine`, `removeSuggestionsLine`, `nearestStoredIndex` unchanged.
- `server/src/storage/node-suggestions.ts`:
  - Delete `SuggestionSnapshot`, `storedSnapshot`, `sameExchange`, `WriteSuggestionsOutcome`,
    `writeNodeSuggestions` and the now-unused imports (`readFile`, `writeFileAtomic`,
    `serializeNodeFile`, `NODE_FILE`, ...).
  - `suggestionsViewOf` always returns `{ node, state: 'ready', suggestions }`.
  - `readCandidates(treeDir, ancestors, askedKeys)`: `used = readUsedKeys(treeDir,
    suggestionTargets(ancestors))`, then `pickCandidates`. No `nearestStoredIndex` slicing.
  - Add `viewSuggestions(treesDir, tree, nodeId)`, moved from `Suggestions.view` /
    `nodeTreeDir`: `existingTreeDir`, then `''` → `InvalidInputError('The tree root has no
    suggestions')`, then `nodeIdSegments(nodeId)`, then `readSuggestionsView`.
- `server/src/storage/index.ts`: `export * from './suggestion-block.js';`.
- `server/src/agent/types.ts`: `AskInput.openSuggestions: string[]` (required). Remove
  `SuggestExchange`, `SuggestInput`, `Agent.suggest` and the `SuggestionCandidate` /
  `SuggestPick` re-exports (check that nothing imports them from `agent/`).
- `server/src/agent/prompt.ts`:
  - `SYSTEM_RULES`: add the "Next questions" section (draft in contract `agent.ts`), with the
    marker interpolated from `SUGGESTIONS_MARKER` (import from `../storage/index.js`; `prompt.ts`
    already imports from storage). Change the last sentence to allow the optional block. The
    section must not name any number.
  - `buildUserPrompt(chain, question, files = [], openSuggestions: string[] = [])`: add the
    `<open-suggestions>` block after `</transcript>` when it is non-empty. Output for `[]` stays
    byte-identical.
  - Delete everything under "Suggestions mirror ...": `SUGGEST_*`, `cutTailAtWord`,
    `headTailExcerpt`, `displayName`, `suggestExchange`, `buildSuggestPrompt`, `isPlainObject`,
    `parseSuggestReply`, and the `SuggestExchange` / `SuggestInput` / `SuggestPick` import. Keep
    `proseExcerpt` (naming uses it).
- `server/src/agent/claude-agent.ts` (keep the uncommitted `oneShotOptions` change):
  - `ask`: `buildUserPrompt(input.chain, input.question, input.files, input.openSuggestions)`.
  - Delete `suggest` and the imports `buildSuggestPrompt`, `parseSuggestReply`,
    `SUGGEST_SYSTEM_PROMPT`, `SuggestInput`, `SuggestPick`.
  - `oneShotOptions` doc comment: "Naming: no tools, one turn and no extended thinking (the SDK
    turns thinking on by default, which only adds latency to a one-word reply)." Drop the
    `SUGGEST_TIMEOUT_MS` mention.
- `server/src/questions/runner.ts`: follow contract `agent.ts` "Runner" steps 1-9.
  - Remove the `PendingSuggestions` / `Suggestions` import, `RunnerDeps.suggestions`, the
    `suggestions` variable, `forAnswer` / `peek` / `adopt` / `abort`, and the `ready` logic.
  - Import `readCandidates`, `suggestionKey`, `SuggestionBlockFilter`, `splitSuggestionBlock`,
    `finalizeSuggestions` from storage.
  - The candidate read goes before `agent.ask`, inside the `try`. Wrap it in
    `.catch((error) => { deps.log.warn(error, ...); return []; })`, then call `throwIfAborted`.
  - The `done` event is still consumed as `answer`. After the loop: `throwIfAborted`, the `answer`
    check, then `registry.appendChunk(job.id, job.attempt, filter.end())`, then split, warn,
    empty check, finalize, then `staging.seal()` and the rest as today. Naming and `createNode`
    use `split.answer`.
- `server/src/questions/service.ts`: remove the `Suggestions` import,
  `QuestionsOptions.suggestions`, the `suggestions` field, and `runnerDeps.suggestions`.
- `server/src/routes/suggestions.ts`: GET only. The handler calls
  `viewSuggestions(treesDir, request.params.tree, request.query.node)` (deps: `treesDir`).
  Delete the POST handler and update the header comment (new contract path; no lock, never 409).
- `server/src/routes/schemas.ts`: delete `suggestionsBody`.
- `server/src/app.ts`: remove the `Suggestions` import, `AppDeps.suggestions`,
  `RouteDeps.suggestions`, its construction, the `suggestions` passed to `Questions`, and
  `suggestions.close()` in `onClose`. `suggestionRoutes` stays registered.
- `server/src/errors.ts`: delete `SuggestionErrorCode` and `SuggestionsFailedError`.
- `server/src/config.ts`: delete `ModelConfig.suggest` and its default. `loadModels` no longer
  reads `OTAGO_SUGGEST_MODEL` and no longer adds it to `available`.
- `server/scripts/ask.ts`: contract `agent.ts` "CLI". Compute `askedKeys` and candidates with
  `readCandidates(treeDir, chain, askedKeys)`, pass `openSuggestions`, and stream through a
  `SuggestionBlockFilter`. Print `filter.end()` after the loop. Split `answer`, name from
  `split.answer`, finalize with `depth: chain.length`, and print the lines from the contract.
  Remove the `agent.suggest` block. Update the header comment.
- `server/.env.example`: if it lists `OTAGO_SUGGEST_MODEL`, delete that line. The planner could
  not read the file because of permissions, so check it.

### Deleted

- `server/src/suggestions/service.ts`, `server/src/suggestions/index.ts` (the whole folder).

### Data model

- `node.md`: format unchanged (`suggestions: <json>`, `{ text, up }`). What changes is when the
  key is written: only at the commit, only when the answer carried a valid block. A block with
  no surviving items is written as `[]`. Nothing is migrated (E9).
- No new frontmatter keys, files or folders.

### Interface changes (wire)

- `GET /api/trees/:tree/suggestions`: always `{ node, state: 'ready', suggestions }`, with the
  E1 fallback and no cap.
- `POST /api/trees/:tree/suggestions`: removed (Fastify 404).
- Error code `suggestions_failed`: removed.
- SSE `chunk` and `live.answer`: same shapes, never contain any part of the block.
- `GET /api/models`: unchanged (it never exposed `suggest`).

## Step order

1. `storage/suggestion-block.ts` plus `test/suggestion-block.test.ts`. Pure, so it can be done
   first and in isolation. Export it from `storage/index.ts`.
2. `storage/suggestions.ts` changes plus the updated `test/suggestions-format.test.ts`.
3. `storage/node-suggestions.ts`: trim it, add `viewSuggestions`, update `readCandidates`.
4. Agent: `types.ts` (`openSuggestions`, no `suggest`), `prompt.ts` (rules, user prompt block,
   deletions), `claude-agent.ts`. Update `test/agent.test.ts`.
5. Runner and service (`runner.ts`, `service.ts`).
6. Routes, app, errors, config, schemas. Delete `server/src/suggestions/`.
7. `test/helpers.ts` and the other test files (below). Rewrite
   `test/questions-suggestions.test.ts` and the GET part of `test/suggestions-api.test.ts`.
8. `scripts/ask.ts`, `.env.example`.
9. Docs (below).
10. `pnpm --filter @otago/server check` (Biome auto-fix; never hand-format), then
    `pnpm --filter @otago/server lint` and `pnpm --filter @otago/server test`. After that, run
    the full `pnpm lint` / `pnpm test`, which only pass once the web and demo plans have landed:
    the demo imports the changed pure modules.

## Test plan

Infrastructure (`test/helpers.ts`):
- `fakeAgent`: remove `suggest`, `suggestGate`, `suggestError`, `suggestCalls`.
  `perQuestionAgent`: remove `suggest` and `suggestCalls`. `FakeAgent = Agent & { calls;
  nameCalls }`.
- `TEST_MODELS`: remove `suggest`. `MakeAppExtra`: remove `suggestTimeoutMs`; add
  `log?: QuestionLogger` (passed to `Questions`) so tests can assert warnings.
- `makeApp`: no `Suggestions`, no `suggestions` in the return value. `settle()`: remove
  `ctx.suggestions.idle()` and update its doc comment.
- Scripts use `suggestionBlock([...])` from `../src/storage/index.js` to build block chunks.

Mechanical updates:
- `test/questions-api.test.ts` (3 inline agents), `test/trees-api.test.ts`,
  `test/nodes-api.test.ts`: delete the inline `async suggest()` methods.
- `test/models.test.ts`: remove `suggest` from the `ModelConfig` literal.
- `test/config.test.ts`: replace the "suggestion model config" describe with: "a leftover
  `OTAGO_SUGGEST_MODEL` is ignored" (`models` has no `suggest` key, and the value is not in
  `available` unless `OTAGO_MODELS` lists it).
- `test/question-files-api.test.ts`: `buildUserPrompt` calls compile unchanged (new optional
  param). Where it rebuilds the prompt from `AskInput`, pass `input.openSuggestions` too.
- `test/agent.test.ts`: delete the "suggestion prompt" describe (`headTailExcerpt`, `SUGGEST_*`,
  `buildSuggestPrompt`, `parseSuggestReply`). Keep "proseExcerpt is the naming excerpt with
  another cap" and move it under naming.

New and rewritten tests:

`test/suggestion-block.test.ts` (pure):
- split: no marker returns the text unchanged with `items` undefined and `rejected` false;
  a block at the end; the marker alone at the end gives `[]`; no trailing newline; CRLF; blank
  lines between items; all bullet kinds; `- ` with no text gives `""`; marker spacing variants
  (`<!--otago:suggestions-->`, indentation); case mismatch is not a marker.
- E3: a marker inside ``` and ~~~ fences (including longer fences and an unclosed fence) is
  kept. A marker followed by prose, footnotes or a closing fence is kept with `rejected` true.
  With two blocks, the last one wins and the first stays as text. `---` and `***` after the
  marker break the block.
- `answer` is the text before the marker with trailing whitespace trimmed.
- Filter invariants, for a set of texts (with block, without block, rejected marker, fenced
  marker, two blocks) and every chunking: one chunk, single characters, and every 2-split
  offset. Check three things:
  - concat(push…, end()) equals `T` (no block) or `T.slice(0, markerLineStart)` (block);
  - every intermediate emitted text is a prefix of the final;
  - with a block, no emitted text contains `<!--`.
- Latency: text without `<` is emitted immediately per chunk. A held `<!--x` line is released
  at its newline. A `<b>` line is released immediately (not a prefix of `<!--`).
- `suggestionBlock(texts)` appended to an answer round-trips through split (also for `[]`).

`test/suggestions-format.test.ts` (update):
- `resolveSuggestions`:
  - a node without a list uses its nearest stored ancestor; `up` is shifted and targets stay
    correct;
  - a stored `[]` stops the fallback; no stored list anywhere gives `[]`;
  - the fallback drops items asked by a node below the owner;
  - no cap (8 items come back);
  - the existing owner-validation, used and dedupe cases keep passing, without the cap
    assertion.
- `suggestionTargets` on the fallback list.
- `pickCandidates` equals the parent's resolved list minus asked keys, with the right `origin`,
  and is uncapped.
- `finalizeSuggestions(texts, ...)`:
  - a verbatim and an NFC/trim-equal text become keeps with `up = depth - origin`;
  - an edited text becomes an own item (E5);
  - empty texts, already-asked texts and duplicates are dropped (E4);
  - own items come first;
  - 8 items, no cap;
  - all dropped gives `[]`.

`test/agent.test.ts` (add):
- `SYSTEM_RULES` contains `SUGGESTIONS_MARKER`, `<open-suggestions>` and "language and script",
  and its next-questions section contains no digit.
- `buildUserPrompt` with `openSuggestions` renders the block between `</transcript>` and
  "Continue the conversation above". With `[]` the output is byte-identical to today (existing
  expectations unchanged).
- `buildAskOptions` and the system prompt still include the tree instructions after the rules.

`test/questions-suggestions.test.ts` (rewrite, end to end through `fakeAgent` chunks):
1. A block is stripped from the saved answer. `node.md` stores `[{ text, up: 0 }]`, the naming
   call got the stripped answer, and `ctx.events.text(id)` has no `<!--` (S1).
2. A marker split across chunks at several offsets never reaches chunk events.
3. Snapshot during the block: gate the stream after the marker chunk. `questions.detail(id).live
   .answer` and a fresh `subscribe` snapshot (and the SSE snapshot via `openEventStream`) have no
   block. The `chunk` offsets stay contiguous (E7).
4. No block: `node.md` has no `suggestions` key, and GET on the new node returns the parent's
   list with `up: 1` (E1, S3).
5. Empty block: stores `suggestions: []`, and GET returns `[]` even though the parent has items
   (E2).
6. A rejected marker (followed by prose, or inside a fence): the answer is stored unchanged, there
   is no key, and the `log.warn` spy was called once. A plain answer without a marker triggers
   no warning.
7. Candidates reach the agent: the parent stores own items plus one item used by a live sibling.
   `agent.calls[0].openSuggestions` lists exactly the unused ones in order. A legacy parent
   without a list passes the grandparent's list. A top-level question gets `[]`.
8. Keep: the child block copies the parent's item, so the child stores `up: 1`, and GET on the
   child gives target = parent (S2). Keep through two levels: the grandparent offers X, the parent
   keeps it (`up: 1`), the child keeps it, and the child stores `up: 2` pointing at the
   grandparent.
9. Asked by hand: a child of the parent asks the parent's item text. The item is no longer
   offered to the next question's agent, and it is hidden on GET (S4).
10. Finalization through the runner: the question's own text, duplicates and an edited copy
    (stored as a new own item) are handled per E4/E5. Ten items are all stored.
11. Cancel while the block streams (gate after the marker): the node is not created, and no chunk
    contains the block. With `failAfter` inside the block, the failed entry's `live.answer` has no
    block. Retry with a different scripted block stores the retry's items (E6). Use an agent
    whose chunks depend on `calls.length`.
12. Attempt timeout mid-block: `failed` with code `timeout`, and no block in the text.
13. An answer that is only a block: `failed` with `agent_error` 'Agent returned an empty answer'.
14. A files-only message (`text: ''`) with a block still stores the items (askedKeys holds `""`
    harmlessly).

`test/suggestions-api.test.ts` (update):
- Delete the whole POST describe and its helpers. Add "POST is gone": 404.
- GET: a legacy node without a list and without stored ancestors gives `ready []`. A legacy node
  under a stored parent gives the parent's items (shifted `up`). A stored `[]` gives `[]`. A
  three-level chain resolves as before. NFC and the 400/404 table are unchanged. Used-hiding and
  soft-deleted children are unchanged. Move away and back: dropped, then shown. The chain payload
  has no suggestions field.
- No cap: a stored list of 7 comes back with 7 items.
- Never 409: GET succeeds while a question of the tree is streaming (gated agent).

Removed tests (covered features no longer exist): the at-save generation tests (parallel with
naming, adoption, POST join, failure keeps missing, cancel aborts the generation), every POST /
lazy-generation / verified-write / dedup / timeout / close test, the `parseSuggestReply` and
`buildSuggestPrompt` tests, and the suggest-model config tests.

## Docs

- `CLAUDE.md`:
  - Commands: the `ask` line becomes "writes nothing; prints the parsed suggestions".
  - Server section: add a bullet "Suggestions (contract `.claude/features/inline-suggestions/
    contracts/`)". It covers: the answering agent may end its answer with a
    `<!-- otago:suggestions -->` block (pure parser/filter in `storage/suggestion-block.ts`); the
    runner reads the parent's open suggestions (`readCandidates`) before asking, passes them as
    `openSuggestions` (`<open-suggestions>` in the user prompt), withholds the block from chunks
    via `SuggestionBlockFilter`, and splits and finalizes it at save (`createNode` writes
    `suggestions:`); no separate generator, no lock, no cap; GET resolves with the ancestor
    fallback.
  - Test helpers paragraph: `fakeAgent` has no `suggest`; script blocks with `suggestionBlock()`;
    `makeApp` takes `log`.
  - Fix stale contract paths `.claude/features/suggested-prompts/contracts/` (archived) to the
    new contract.
  - The Web "Suggested questions" and Demo "Suggested prompts" paragraphs: rewritten by the web
    and demo plans (no `missing`, no POST, no `generateSuggestionsOnce`, no cap; the demo
    simulates the block).
- `README.md`: no suggestion or `OTAGO_SUGGEST_MODEL` mention today, so nothing to change unless
  a features list mentions suggestions (re-check while implementing).
- `docs/design.md` does not exist in this checkout, so nothing to change.
- Source header comments that cite `.claude/features/suggested-prompts/contracts/` in
  `storage/suggestions.ts`, `storage/node-suggestions.ts` and `routes/suggestions.ts`: point to
  the new contract.

## Notes for the web and demo plans

- Wire: GET always returns `state: 'ready'`. POST and `suggestions_failed` are gone. Remove
  `generateSuggestions` (client and demo shim, keep `exportsComplete` happy),
  `generateSuggestionsOnce`, the `missing` branch, and the web cap `MAX_SUGGESTIONS` in
  `web/src/lib/suggestions.ts`.
- Streamed text never contains the block. The web must not parse it.
- Demo pure imports change. `MAX_SUGGESTIONS` and `SuggestPick` are gone.
  `resolveSuggestions` returns `Suggestion[]` (never `'missing'`) and needs `user` on chain
  records. `pickCandidates` and `finalizeSuggestions(texts, …)` have new semantics/signatures.
  The new `storage/suggestion-block.ts` exports `SuggestionBlockFilter`,
  `splitSuggestionBlock`, `suggestionBlock` and `SUGGESTIONS_MARKER`. `writeNodeSuggestions`
  was never imported by the demo, but `mock/suggestions.ts` (lazy POST, adoption, later write)
  has no server counterpart any more.
- The demo simulator should end some answers with `suggestionBlock([...])`, built from
  `pickCandidates` (to sometimes keep candidates verbatim). It streams through
  `SuggestionBlockFilter` and stores `finalizeSuggestions(split.items, …)` at commit.
