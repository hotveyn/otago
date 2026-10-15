# Server plan: suggested-prompts

Project: `server` (`@otago/server`, Node 22, Fastify + Zod, Vitest). Role: contract owner.
Contract: `.claude/features/suggested-prompts/contracts/` (`index.ts` lists files and decisions).
No research file existed; this plan is based on reading `server/src` and the `parallel-questions` contract.

## Summary of the design

- **Storage.** One frontmatter line in `node.md`: `suggestions: [{"text":"…","up":1}, …]` (single-line JSON, which is valid YAML; checked against gray-matter). If the key is missing, the list is *missing*. `[]` means *stored, empty*. `up` counts levels above the node (0 means the node's own suggestion). An inherited item always points at the ancestor that first offered it, and on read it is checked against that ancestor's own list.
- **API.** There is a separate resource. `GET /api/trees/:tree/suggestions?node=` is a pure read: it resolves the list and filters out "used" items, and its `state` is `ready` or `missing`. `POST /api/trees/:tree/suggestions {node}` runs lazy generation: idempotent, deduplicated per node in memory, takes no lock, returns 502 `suggestions_failed` on failure. The chain payload, the question routes and SSE do not change.
- **When suggestions are generated.** On save, generation runs in parallel with naming. The commit never waits for it. If generation is still running at commit, the suggestion service takes it over and writes the result after the commit, using the same verified write as the lazy path.
- **Model.** `OTAGO_SUGGEST_MODEL` is the model setting. It defaults to the naming default and goes into `ModelConfig.suggest`.
- **Agent.** The `Agent` interface gets `suggest(input): Promise<SuggestPick[]>`. Prompt building and reply parsing go in `agent/prompt.ts`. Sanitizing, mapping and capping happen in the pure `finalizeSuggestions`, so fake agents return raw picks.

## Files

### New

| Path | Purpose |
|---|---|
| `server/src/storage/suggestions.ts` | **Pure and Node-free.** It may import only `../text.js`, because the demo imports it. Types `StoredSuggestion`, `Suggestion`, `SuggestionCandidate`, `SuggestPick`. Constants `SUGGESTIONS_KEY`, `MAX_SUGGESTIONS = 5`, `SUGGESTION_MAX_GRAPHEMES = 200`. Functions: `suggestionKey`, `sanitizeSuggestionText`, `parseStoredSuggestions(value: unknown): StoredSuggestion[] \| undefined`, `suggestionsLine(items)` (JSON plus U+2028/2029 escaping), `setSuggestionsLine(fileText, items)` (textual splice, see contract `node-file.ts` rule 3), `resolveSuggestions(chain, usedKeysByTarget)`, `pickCandidates(chain, usedKeysByTarget, askedKeys)`, `finalizeSuggestions(picks, candidates, ctx)`. |
| `server/src/storage/node-suggestions.ts` | Disk side. `readChildQuestionKeys(treeDir, nodeId): Promise<Set<string>>` returns the keys of live children's `user`, using the same filters as `readChildren`: `isNodeName`, not reserved, has `node.md`, NFC/fold twins skipped. `readSuggestionsView(treeDir, nodeId): Promise<SuggestionsResponse-ish>` reads the chain, collects the distinct targets, scans children, then resolves. `writeNodeSuggestions(treeDir, nodeId, snapshot, items): Promise<'written' \| 'stored' \| 'gone' \| 'changed'>` is the verified write (re-read, compare `created`/`user`/`assistant`, check still missing, splice, `writeFileAtomic`; ENOENT → `'gone'`). |
| `server/src/suggestions/service.ts` | `class Suggestions`. Options: `{ agent, treesDir, model, timings?: { timeoutMs }, log? }`. It keeps the in-flight map `Map<string /* tree\0node */, Promise<StoredSuggestion[]>>`, a set of AbortControllers, and a `closed` flag. Methods are listed under "Service API" below. |
| `server/src/suggestions/index.ts` | Barrel. |
| `server/src/routes/suggestions.ts` | `GET` and `POST /trees/:tree/suggestions`. |
| `server/test/suggestions-format.test.ts` | Pure tests: storage format, splice, sanitize, resolve, finalize, candidates. |
| `server/test/suggestions-api.test.ts` | Route tests for the lazy path, races and errors. |
| `server/test/questions-suggestions.test.ts` | At-save path in the question runner. |

### Changed

| Path | Change |
|---|---|
| `server/src/storage/format.ts` | `NodeFile.suggestions?: StoredSuggestion[]`. `parseNodeFile` sets it from `parseStoredSuggestions(data.suggestions)` only when that is defined, so deep-equality tests on old files keep passing. `serializeNodeFile` keeps today's output and, when `suggestions` is an array, passes it through `setSuggestionsLine`. A node without the field serializes byte-identically to today. |
| `server/src/storage/index.ts` | Export `suggestions.js` and `node-suggestions.js`. |
| `server/src/storage/nodes.ts` | Export a small `readNodeFileIfExists`, or add `readNodeFile(treeDir, id)`, for the verified write, and expose the child-listing filter that `readChildQuestionKeys` reuses. Keep `readChildren` private; factor out the entry filtering into `liveChildEntries(dir, parentId)`. |
| `server/src/routes/trees.ts` | Chain route: strip `suggestions` from every chain node (`chain.map(({ suggestions: _, ...node }) => node)`) so the wire `ChainNode` stays unchanged. |
| `server/src/agent/types.ts` | `SuggestExchange`, `SuggestInput`. Re-export `SuggestPick`/`SuggestionCandidate` from storage. Add `Agent.suggest(input: SuggestInput): Promise<SuggestPick[]>`. |
| `server/src/agent/prompt.ts` | Refactor `namingExcerpt` into `proseExcerpt(answer, max)`, which runs cleaning steps 1-4. `namingExcerpt` becomes `proseExcerpt(answer, NAMING_EXCERPT_MAX_CHARS)`, and naming tests must stay green. Add `headTailExcerpt(answer, {head, tail})`, `SUGGEST_SYSTEM_PROMPT`, `SUGGEST_PROMPT`, the constants from contract `generation.ts`, `buildSuggestPrompt(input)`, and `parseSuggestReply(raw, candidateCount)`. |
| `server/src/agent/claude-agent.ts` | `suggest()` works like `name()`: `baseOptions`, `tools: []`, `maxTurns: 1`, `systemPrompt: SUGGEST_SYSTEM_PROMPT`. It parses `message.result` with `parseSuggestReply` and throws on a non-success result or when there is no result. |
| `server/src/config.ts` | `ModelConfig.suggest`. `DEFAULT_MODELS.suggest = 'claude-haiku-4-5'`. `loadModels`: `suggest = env.OTAGO_SUGGEST_MODEL \|\| naming`, added to `available`. |
| `server/src/questions/runner.ts` | Parallel generation and adoption; see "Runner changes". `RunnerDeps.suggestions?: Suggestions`. |
| `server/src/questions/service.ts` | `QuestionsOptions.suggestions?: Suggestions`, passed into `runnerDeps`. |
| `server/src/app.ts` | `AppDeps.suggestions?`. Build `new Suggestions({ agent, treesDir, model: models.suggest, log: app.log })` before `Questions` and pass it in. `RouteDeps.suggestions`. Register `suggestionRoutes`. In `onClose`, also call `await suggestions.close()` after `questions.close()`. |
| `server/src/errors.ts` | `SuggestionErrorCode = 'suggestions_failed'`. `class SuggestionsFailedError extends AppError` (502, exact message from contract `errors.ts`). Add the code to the `AppError.code` union. |
| `server/src/routes/schemas.ts` | `suggestionsQuery = z.object({ node: nodeId })`, `suggestionsBody = z.object({ node: nodeId })`. |
| `server/test/helpers.ts` | `fakeAgent` options: `suggest?: SuggestPick[] \| ((input) => SuggestPick[] \| Promise<SuggestPick[]>)` (default `[]`), `suggestGate?`, `suggestError?`, plus a `suggestCalls` recorder. `perQuestionAgent.suggest` returns `[]`. `FakeAgent` type gets `suggestCalls`. `TEST_MODELS.suggest = 'naming-default'`. `makeApp` builds one `Suggestions` (shrunken `timings.suggestTimeoutMs` via `extra.suggestTimeoutMs`), passes it to both `Questions` and `buildApp`, and returns `suggestions` in the context. |
| `server/scripts/ask.ts` | Optional. After naming, call `agent.suggest` with the chain and an empty candidate list and print the picks. This is a manual smoke test of the real prompt and is still read-only. |
| `server/.env.example`, README env table | Document `OTAGO_SUGGEST_MODEL` (default: the naming model). |
| `CLAUDE.md` (repo) | One bullet under Architecture → Server about `suggestions/` and the `suggestions:` frontmatter, and add `OTAGO_SUGGEST_MODEL` to the config list. Do this at the end of implement. |

## Data-model change (node.md)

See contract `node-file.ts`. Summary:
- If the `suggestions` key is absent or not an array, the list is missing. An array means stored. Invalid items are dropped on read and item text is re-sanitized.
- Every writer emits the single-line JSON form. New nodes get the line right before the closing `---`. Later writes splice only that line and leave the rest of the file byte-for-byte.
- Older server builds ignore the key, so the file stays forward compatible.

## Service API (`suggestions/service.ts`)

```ts
class Suggestions {
  constructor(o: { agent: Agent; treesDir: string; model: string; timings?: { timeoutMs?: number }; log?: QuestionLogger });
  /** GET: pure read. 404 tree/node, 400 for "" (InvalidInputError). */
  view(tree: string, nodeId: string): Promise<SuggestionsResponse>;
  /** POST: stored → view; else join/start; await; re-view. Throws SuggestionsFailedError / NotFoundError. */
  ensure(tree: string, nodeId: string): Promise<SuggestionsReady>;
  /** Runner: start an at-save generation (not yet keyed). */
  forAnswer(input: { treeDir: string; parentId: string; question: string; answer: string; signal: AbortSignal }): PendingSuggestions;
  close(): Promise<void>;
}
interface PendingSuggestions {
  /** Settled value: array on success, null on failure, undefined while running. */
  peek(): StoredSuggestion[] | null | undefined;
  /** After commit, if still running: key it under (tree, nodeId) and write when done (verified write). */
  adopt(tree: string, nodeId: string, snapshot: { created: string; user: string; assistant: string }): void;
  abort(): void;
}
```

Internals:
- `generate(ancestors: ChainNode[], current, signal)` does the following. Compute the used keys for the candidate targets (`readChildQuestionKeys` per distinct target). Run `pickCandidates`. Call `agent.suggest({ ancestors, current, candidates, model, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })`. Run `finalizeSuggestions` with `depth = ancestors.length` and `askedKeys` = the keys of every ancestor `user` plus the current `user`. For a files-only node, also add the stored `user` `""`, which matches nothing.
- Each generation's own `AbortController` is tracked in a set. `close()` aborts all of them, sets `closed`, and waits for them to settle. After `closed`, no write happens: check it right before the write.
- Dedup map entries are deleted in `finally`, so the entry is gone on success and on failure.
- Lazy path inside `ensure`: `existingTreeDir` (404 `tree_not_found`). `nodeIdSegments` validates (400). Reject `""` with an `InvalidInputError('The tree root has no suggestions')`. `readChain(treeDir, nodeId)`: a NotFound is mapped to 404 `node_not_found`. If the list is stored, return the view. Otherwise, under the key, run `generate(chain.slice(0, -1), last, controller.signal)`, then `writeNodeSuggestions`. Outcome `'gone'` or `'changed'` rejects with `SuggestionsFailedError` (`changed`) or `NotFoundError node_not_found` (`gone`). `'stored'` resolves. Then `view` again: a NotFound there becomes 404. Generation errors are logged at `warn` and become `SuggestionsFailedError`.
- **No tree lock anywhere in this service.**

## Runner changes (`questions/runner.ts`)

After `registry.setNaming(...)`:

1. `const pending = deps.suggestions?.forAnswer({ treeDir: job.treeDir, parentId: job.parentId, question: job.namingQuestion, answer: final.text, signal })`. Inside, `forAnswer` re-reads `readChain(treeDir, parentId)` to get fresh ancestor lists. Its controller is linked to the attempt `signal` only until `adopt()` or settle. Read errors count as a failure (missing).
2. `agent.name(...)` runs as today. The two calls run concurrently; naming is not wrapped in `Promise.all`.
3. On the existing abort paths (`throwIfAborted` throwing before commit), call `pending?.abort()`. Simplest: abort in `settleFailure` too, through a `job.pendingSuggestions` field or a local `try/finally` guard.
4. At the commit point: `const ready = pending?.peek()`. `createNode(..., { created, model, user, assistant, ...(Array.isArray(ready) ? { suggestions: ready } : {}) }, …)`.
5. After `createNode` succeeds: if `ready === undefined && pending`, call `pending.adopt(registry.get(job.id)?.tree ?? '', nodeId, { created, user: job.text, assistant: final.text })`. Use the same `created` value that was passed to `createNode`; it is hoisted into a const.
6. `registry.complete(...)` runs right away, as today. The question never waits for suggestions and never fails because of them.

While the question is `naming`, the shared lock is held, so the parent chain cannot move. After adoption, the verified write deals with moves, deletes and renames.

## Routes (`routes/suggestions.ts`)

```text
GET  /trees/:tree/suggestions   querystring suggestionsQuery → suggestions.view(tree, node)
POST /trees/:tree/suggestions   body suggestionsBody        → suggestions.ensure(tree, node)
```
Neither route touches `locks`. The POST does not abort on client disconnect: do not listen to `raw.on('close')`.

## Step ordering

1. `errors.ts`, then `config.ts` (`suggest`), then `test/config.test.ts`.
2. `storage/suggestions.ts` (pure) and `test/suggestions-format.test.ts`. Check that the file has no `node:` imports and that `text.ts` stays Node-free.
3. `storage/format.ts` (`NodeFile.suggestions`, serialize via `setSuggestionsLine`) and storage tests (round-trip).
4. `storage/nodes.ts` refactor (child entries helper, node-file read export), then `storage/node-suggestions.ts`.
5. Agent: `types.ts`, `prompt.ts` (refactor the excerpt; suggest prompt and parser), `claude-agent.ts`, `test/agent.test.ts` additions.
6. `test/helpers.ts`: fake agent `suggest`, `makeApp` wiring. This step is needed before steps 7-9 compile.
7. `suggestions/service.ts` and `routes/suggestions.ts`, `app.ts` wiring, `routes/trees.ts` chain strip, then `test/suggestions-api.test.ts`.
8. Runner and service wiring, then `test/questions-suggestions.test.ts`.
9. `scripts/ask.ts` (optional), docs/CLAUDE.md, then `pnpm check`, `pnpm lint` and `pnpm test` from the repo root.
10. Hand off: web and demo plan against the contract. The demo imports `server/src/storage/suggestions.ts` for parse, line, resolve and finalize.

## Test plan

No real SDK calls; everything goes through `fakeAgent`. Use `makeTempDir`/`makeApp`/`askAndSettle`/`waitFor`/`deferred` from `test/helpers.ts`.

### `test/suggestions-format.test.ts` (pure)
- `parseStoredSuggestions`: `undefined` gives missing. `null`, a string or a map give missing. `[]` gives `[]`. Items with a bad `text`, a negative, fractional or string `up` are dropped. Unknown keys are ignored. Text is re-sanitized.
- `sanitizeSuggestionText`: whitespace and newlines collapse. Wrapping quotes (`"…"`, `«…»`) are stripped. NFC is applied (NFD input becomes NFC). Lone surrogates are fixed. Text is cut at 200 graphemes without splitting an emoji or a combining sequence. Empty input gives `null`.
- `suggestionsLine`: one line, JSON, U+2028 escaped. Round trip through `gray-matter` (`parseNodeFile`) gives back the same items, including Cyrillic, `#`, `: `, quotes and backslashes.
- `setSuggestionsLine`: inserts before the closing `---`, and all other bytes stay identical (compare `before`/`after` with the line removed). Replaces an existing single line. Replaces a block-style YAML list together with its continuation lines. Keeps CRLF files CRLF. Throws without frontmatter.
- `serializeNodeFile`: without `suggestions`, the output is identical to the pre-feature output (snapshot an old fixture). With `[]` it writes the line `suggestions: []`.
- `resolveSuggestions`: missing gives `'missing'`. Own items target self. An inherited item resolves to the ancestor id. It is dropped when `up ≥ chain.length`, when the ancestor's list is missing, or when the ancestor's own list lacks the text (the moved-node case, simulated by changing the chain). Own beats inherited on duplicates. Used keys drop items per target. The cap is 5.
- `finalizeSuggestions`: `keep` maps to `up = depth - origin`, and the text stays verbatim. A new text equal to a candidate becomes a keep. Out-of-range keeps are dropped. Asked keys (chain `user`s and the current one) are dropped. Duplicates are removed. Own items come first. The cap is 5. All dropped gives `[]`.
- `pickCandidates`: the nearest stored ancestor is used and missing ones are skipped. A stored empty parent stops inheritance. Candidates come from that ancestor's resolved list, with origins pointing at the original owners. Used items and already asked items are excluded.

### `test/agent.test.ts` additions
- `buildSuggestPrompt`: candidates are numbered from 1 with source names. At most 4 ancestors are included, oldest first. The head/tail excerpt is applied to a long answer, and the tail contains the last paragraph. Blocks are omitted when they are empty.
- `parseSuggestReply`: handles a fenced reply, a bare array, `{suggestions}`, string items, converts 1-based keeps to 0-based, drops out-of-range or bad items, and throws on garbage or on `{}` without an array.
- `namingExcerpt` behavior is unchanged after the refactor (existing tests).

### `test/suggestions-api.test.ts`
- GET: an old node (no key) gives `missing`. A node with stored `[]` gives `ready, []`. Own and inherited items resolve, and `target`/`up` are correct for a 3-level chain written by hand. Tree root `""` gives 400. A bad id gives 400. An unknown tree gives 404 `tree_not_found`. An unknown node gives 404 `node_not_found`.
- GET "used": a sibling child whose `user` equals the suggestion (also with NFD or extra outer whitespace in the child's text) hides it. A soft-deleted child with that text does not hide it.
- GET after a move: move the node under another parent so the inherited item no longer matches the new ancestor's own list; the item disappears. Moving it back makes it reappear.
- Chain route payload has no `suggestions` field.
- POST on a missing node: one `suggest` call. `node.md` gets the line and every other byte is unchanged (compare with the splice expectation). The response is `ready`. A second POST makes no call.
- POST dedup: two concurrent POSTs plus a GET, with `suggestGate` held, lead to exactly one `suggestCalls` entry. Both POSTs get 200 with the same list.
- POST failure: `suggestError` gives 502 `suggestions_failed` and the file has no key. The next POST calls again and succeeds. An unparseable reply goes through the same path. With a shrunken timeout and a never-resolving gate, the request times out with 502.
- POST takes no lock: while a generation is gated, `POST /nodes/move`, `/nodes/rename`, `/nodes/delete`, `/nodes/restore` and a title `PATCH` all return 200. Afterwards: moved or renamed means the POST gets 404 and the node file at the new location has no key. Deleted means 404, the trash folder's `node.md` is unchanged, and no folder exists at the old path (`stat` gives ENOENT). The node was moved back during the gate means it is written.
- POST when the file changed during generation (rewrite `assistant` by hand) gives 502, and nothing is written.
- POST when another writer stored a list meanwhile (write the line by hand during the gate) gives 200 with the stored list, and ours is discarded.
- `app.close()` during a gated generation: the generation is aborted and nothing is written afterwards.

### `test/questions-suggestions.test.ts`
- Suggest resolves before naming (use `nameGate`): `node.md` is created with the line, so there is a single write.
- Suggest slower than naming (`suggestGate` held): the question reaches `done` (`askAndSettle` returns) while the gate is closed, and the file has no key. Open the gate, then `waitFor` the key to appear. A POST for that node issued before opening the gate does not cause a second `suggest` call.
- Suggest fails: the question is `done`, the key is missing, and no failure event or status change happens (same event kinds as today).
- Cancel during naming (`nameGate` plus DELETE): the suggest signal is aborted (assert through the fake recording `input.signal.aborted`), and no node or write happens.
- Inheritance end to end. Ask "plan" with `suggest: [{text:'Глава 1'},{text:'Глава 2'},{text:'Глава 3'}]`. Ask "Глава 1" under the plan with a fake that keeps candidates 0 and 1. The second call's `candidates` are exactly Глава 2 and Глава 3 (Глава 1 is excluded as asked) with source `plan`. The stored items have `up: 1`. GET on the child returns targets `plan`. Then ask "Глава 2" under the plan; GET on the child no longer shows it (used).
- `suggest` input uses `models.suggest` (`TEST_MODELS.suggest`) and gets `Attached files: …` as the question for a files-only message.
- Existing question tests stay green. The default fake returns `[]`, so new nodes get `suggestions: []`. Assertions that use `toMatchObject` and `parseNodeFile` are unaffected. Check `storage.test.ts` byte-equality tests, which use `createNode` without suggestions and so are unaffected.

### `test/config.test.ts`
- `OTAGO_SUGGEST_MODEL` unset gives the naming default, also when `OTAGO_NAMING_MODEL` is overridden. When set, it is used and added to `available`.

## Open questions

1. **Side panel and inherited targets above the anchor.** The server's `validateContext` rule is unchanged. The web has to hide such items in the side panel or send them with `anchor: target`. This is flagged in contract `suggestions-api.ts` for the web plan.
2. **Failed in-flight questions and hiding.** The contract says entries of any status in the store hide a matching suggestion, including `failed` ones (they can be retried). If the web would rather re-show suggestions for failed or dismissed questions, that is a client-only choice.
3. **Failure cooldown.** There is no server-side negative cache after a 502. The web's "once per open" rule bounds cost. A cooldown in `Suggestions` could be added later if a loop shows up.
4. **Prompt quality.** The wording is the implementer's. Tune it with `scripts/ask.ts` on a real tree, Russian and English, before merging. If quality is poor on Haiku, `OTAGO_SUGGEST_MODEL` lets the user pick a stronger model.
