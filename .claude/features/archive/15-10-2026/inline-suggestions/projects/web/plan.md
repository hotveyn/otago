# Plan: web (`@otago/web`, client) for `inline-suggestions`

Contract (server-owned, planned against strictly): `.claude/features/inline-suggestions/contracts/`
(mainly `suggestions-api.ts` "CLIENT RULES", `suggestions.ts` `Suggestion`, `errors.ts`,
`shared.ts` `StreamedTextGuarantee`).

## What changes for the web

The web gets smaller. Suggestions are now written by the server at commit time from the
answering agent's block. The web only reads them.

- `GET /trees/:tree/suggestions?node=` always answers `{ node, state: 'ready', suggestions }`.
  The `missing` variant is gone. A node without its own list already comes back with its
  nearest ancestor's list, so every item has `up > 0`.
- `POST /trees/:tree/suggestions` is gone (404), and so is the `suggestions_failed` code (502).
- No cap anywhere: the panel shows every item the server returns.
- `chunk` events and `live.answer` never contain the block. The web must NOT parse, detect or
  hide `<!-- otago:suggestions -->`. Nothing in the streaming path (`api/sse.ts`,
  `api/question-events.ts`, `lib/questions.ts`, `Markdown.tsx`) changes.
- Unchanged: query key `['suggestions', tree, node]`, no placeholder data, invalidation points
  (`QuestionEffects` on done/removed, `GraphView` `applyHierarchy`, undo, title changes), the
  in-flight hiding rule, the side-panel anchor rule, the "own wins" dedupe, `askSuggestion`,
  `SuggestionList` markup, i18n strings and CSS.

No data-model changes on the web side (no persisted state, no URL params, no sessionStorage
touches suggestions).

## Files to change

### 1. `web/src/api/types.ts` (hand-mirrored wire types)
- File header: replace `.claude/features/suggested-prompts/contracts` with
  `.claude/features/inline-suggestions/contracts`. The base suggested-prompts contract is
  archived, and the new contract restates every shape the web uses.
- Section comment (line ~356): "Suggested questions. Mirrors
  .claude/features/inline-suggestions/contracts/suggestions.ts, suggestions-api.ts and
  errors.ts."
- `Suggestion`: shape unchanged. Doc of `up`: add "a node shown through the ancestor fallback
  has only inherited items (`up > 0`)".
- `SuggestionsReady`: doc becomes "`GET /trees/:tree/suggestions`: the resolved list: the
  node's own stored list, or its nearest stored ancestor's list when it has none; `[]` =
  nothing to show. Own first, then inherited; invalid and "used" items already removed; not
  capped." Drop the `POST` mention.
- DELETE `SuggestionsMissing`.
- `SuggestionsResponse`: KEEP as `export type SuggestionsResponse = SuggestionsReady;` (the same
  alias as the contract). This avoids churn in `client.ts` and in the demo, which imports the
  name in `demo/src/mock/trees.ts`.
- DELETE `SuggestionErrorCode` and remove it from `ErrorBody.code`. Update the `ErrorBody.code`
  doc comment: drop "and the 502 of a failed suggestion generation".

### 2. `web/src/api/client.ts`
- Imports: drop `SuggestionErrorCode` and `SuggestionsReady` (only `generateSuggestions` uses
  `SuggestionsReady`; re-check after the edit). Keep `SuggestionsResponse`.
- `ApiErrorCode`: remove `| SuggestionErrorCode`.
- DELETE `SUGGESTION_ERROR_CODES` and its use in `isErrorCode`.
- `getSuggestions`: doc becomes "Pure read; always `state: 'ready'` (the server resolves the
  ancestor fallback)". Signature and URL unchanged.
- DELETE `generateSuggestions` with its doc comment.
- Demo note: the demo shim (`demo/src/mock/client.ts` / `mock/demo.ts`) must drop its own
  `generateSuggestions` in the same change, because `exportsComplete` checks the export set.
  That is the demo plan's job (see "Ordering").

### 3. `web/src/api/queries.ts`
- DELETE the `generating` map and `generateSuggestionsOnce`.
- `useNodeSuggestions(tree, node)`: keep the name, signature and `Suggestion[] | null` return.
  Body becomes a plain `useQuery` (same key, same `queryFn`, `enabled = node !== null &&
  node !== ''`). Return `enabled && query.data ? query.data.suggestions : null`. Remove
  `useQueryClient`, both `useRef`s and the `useEffect`. Doc: "Suggestions of a saved node:
  `null` while unknown (loading, error, disabled), else the server's resolved list (final; no
  lazy generation). No placeholder data: a previous node's buttons would send to the wrong
  targets."
- Imports: drop `SuggestionsReady`, the whole `react` import (only the removed code uses
  `useEffect` and `useRef`) and `useQueryClient`. Keep the `type QueryClient` import
  (`moveTreeCaches`, `dropTreeCaches`, `seedDoneChain`).

### 4. `web/src/lib/suggestions.ts`
- Header: contract path becomes `.claude/features/inline-suggestions/contracts/`.
- DELETE `MAX_SUGGESTIONS` and the `if (result.length === MAX_SUGGESTIONS) break;` line.
- `visibleSuggestions` doc: drop step 4 ("cap"). Add a note that a list that came through the
  ancestor fallback (all `up > 0`) goes through the same steps. `SUGGESTION_LABEL_GRAPHEMES`
  (button label cut) stays.
- Everything else unchanged (`suggestionKey`, `inFlightSuggestionKeys`, `suggestionLabel`,
  `suggestionSource`, `hasInFlightSuggestion`, `askSuggestion`).

### 5. `web/src/components/chat/useSuggestions.ts`
- Logic unchanged. Doc comment: replace "(fetched, generated lazily once when missing)" with
  "(fetched; the server already resolved the ancestor fallback)".

### 6. `web/src/components/chat/SuggestionList.tsx`
- Prop doc: "Already filtered (`useSuggestions`)", without "and capped". Markup unchanged.
  Inherited-only lists render with the existing source tag (`suggestions.from`) and the
  `askUnder` title. The `.suggestions` container already uses `flex-wrap`, so more items wrap
  and `web/src/styles/base.css` needs no change.

### 7. `web/src/components/QuestionEffects.tsx`
- No logic change. The `onDone` invalidation of `keys.treeSuggestions(tree)` (awaited before
  the ack) stays. Optional comment tweak on the existing comment: the new node's own list is
  already in `node.md` when `done` arrives, so the same refetch brings its buttons, and there
  is no "moments later" window. `seedDoneChain` keeps using the streamed text. It is
  block-free by contract (the server withholds from the marker line on), and after the trim
  it matches the saved answer, so it needs no change.

### 8. Not changed (checked)
- `web/src/i18n/locales/{en,ru}/chat.ts`: the `suggestions.label/from/askUnder` keys stay. No
  string mentions generation or failure.
- `ChatView.tsx`, `SideChatView.tsx`, `ChatThread.tsx` (`tail`/`tailKey`), `GraphView.tsx`
  (`applyHierarchy` invalidation), `base.css`.
- `lib/chat-errors.ts`: has no suggestion code.

### 9. `CLAUDE.md` (repo root), Web section, "Suggested questions" paragraph
Rewrite to, in substance:
> Suggested questions (contract `.claude/features/inline-suggestions/contracts/`):
> `GET /trees/:tree/suggestions?node=` is its own query (`['suggestions', tree, node]`, no
> placeholder data). It always answers `ready`: the server stores the answering agent's
> predicted questions at save, and a node without its own list gets its nearest ancestor's
> list (all items inherited). There is no lazy generation or POST. The streamed text never
> contains the agent's suggestion block, so the web never parses it.
> `components/chat/useSuggestions.ts` shows them as `SuggestionList` under the panel's last
> saved exchange (`ChatThread` `tail`) only when the store is hydrated and nothing is in
> flight. `lib/suggestions.ts` hides items with a store entry under the same target and
> `suggestionKey` (…unchanged…), drops side-panel targets above the anchor, and lets own items
> win. There is no cap. A click is `askSuggestion` (…unchanged…).

The Server and Demo paragraphs are edited by the server and demo plans. Touch only this
paragraph.

## Tests (colocated, Vitest)

### `web/src/lib/suggestions.test.ts`
- Remove the `MAX_SUGGESTIONS` import.
- Replace `'caps and keeps the order'` with `'shows every item in order (no cap)'`: 7 (or 12)
  own items come back unchanged (`toEqual(list)`).
- Add `'passes an inherited-only list (ancestor fallback) through the same rules'`: a list with
  only `up > 0` items (two targets). Without an anchor all are kept. With a side anchor below
  one target, the items above the anchor are dropped. An in-flight key for one item hides
  only that item.

### `web/src/api/queries.test.ts`
- Remove the `generateSuggestionsOnce` import and its three tests ("makes one POST…", "leaves
  the cache alone on failure…", "keeps nodes and trees apart"), plus the `deferred` helper if
  nothing else uses it.
- Keep `'invalidates every node of a tree through the tree prefix'` and the `ready` helper.
- `dropTreeCaches` test: replace the seeded `{ node: 'a', state: 'missing' }` values with
  `ready('a')`-shaped data (`{ node: 'a', state: 'ready', suggestions: [] }`). The cache values
  are irrelevant to the assertion, but they should not show a removed shape.
- `vi`/`afterEach` imports: drop them if nothing else uses them.

### `web/src/api/client.test.ts` (suggestions `describe`)
- Keep `'reads a node with the id percent-encoded'`.
- Replace `'returns the missing shape as is'` with `'returns an inherited-only ready list as
  is'` (`{ node: 'a/b', state: 'ready', suggestions: [{ text: 'Глава 4', target: 'a', up: 1 }] }`).
- DELETE `'generates with a JSON POST of the node'` and `'reads the 502 suggestions_failed
  code'`.
- Change `'keeps the 404 node_not_found code'` to call `api.getSuggestions('t', 'a')`. GET
  still returns 404 `node_not_found` for a missing node.
- Add `'does not recognize suggestions_failed as a code'`: a 502
  `{ error: 'x', code: 'suggestions_failed' }` from `getSuggestions` gives an `ApiError` with
  `code === undefined`. `request` keeps only codes that pass `isErrorCode` (`client.ts`
  ~line 106), so this test fails until the code is removed from the list.
- Add `'exposes no generateSuggestions'`: `expect('generateSuggestions' in api).toBe(false)`.
  This guards the removal that the demo's `exportsComplete` depends on.

### `web/src/components/chat/SuggestionList.test.tsx`
- Add `'renders every item (no cap)'`: 8 items give 8 `.suggestion` buttons in order.
- Add `'tags every item of an inherited-only list'`: all `up > 0`, each with a source tag.

### Not added
- No hook test for `useNodeSuggestions` / `useSuggestions`: the web has no React testing
  library (`web/package.json`). After the change the hook is a plain `useQuery` with no logic.

## Step ordering

1. `api/types.ts`: remove `SuggestionsMissing` and `SuggestionErrorCode`, alias
   `SuggestionsResponse`, update docs.
2. `api/client.ts`: remove `generateSuggestions`, `SUGGESTION_ERROR_CODES` and the
   `ApiErrorCode` member.
3. `api/queries.ts`: remove `generateSuggestionsOnce`, simplify `useNodeSuggestions`.
4. `lib/suggestions.ts`: remove the cap. Comment tweaks in `useSuggestions.ts`,
   `SuggestionList.tsx` and `QuestionEffects.tsx`.
5. Tests as above.
6. `CLAUDE.md` Web paragraph.
7. `pnpm format`, then `pnpm --filter @otago/web lint` and `pnpm --filter @otago/web test`.
   Never hand-format.

### Cross-project ordering
- The web change type-checks on its own (`pnpm --filter @otago/web lint`).
- The demo imports `web/src/api/types.ts` and shims `web/src/api/client.ts`. Removing
  `SuggestionErrorCode` from `ApiErrorCode` and `generateSuggestions` from `api` breaks
  `demo/src/mock/errors.ts` (`'suggestions_failed'`), `mock/demo.ts` (`generateSuggestions`)
  and the demo tests until the demo plan lands. The repo-wide `pnpm lint` / `pnpm test` /
  `pnpm build` therefore pass only when server, web and demo ship together, as `feature.md`
  E10 says. Implement the web before or with the demo.
- The web does not depend on the server landing first: the GET wire shape stays valid for
  both servers (the old server's `missing` would show no buttons, which is harmless).

## Regeneration commands
None. The web types are hand-maintained mirrors (no codegen in this repo).

## Verification checklist
- `grep -rn "generateSuggestions\|SuggestionsMissing\|suggestions_failed\|MAX_SUGGESTIONS\|SuggestionErrorCode\|state: 'missing'" web/src`
  finds nothing.
- `grep -rn "suggested-prompts" web/src CLAUDE.md` finds nothing in the Web paragraph or web
  sources.
- `grep -rn "otago:suggestions" web/src` finds nothing (the web never parses the block).
- Manual (`pnpm dev`): answer a chapter question and the buttons show right after the save.
  A side question below it shows the parent's suggestion with the source tag (stored or
  fallback), and clicking it creates the node under the parent. No network call to
  `POST …/suggestions` when old nodes are opened.
