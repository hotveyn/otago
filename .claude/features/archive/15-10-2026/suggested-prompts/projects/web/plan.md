# Web plan: suggested-prompts

Project: `web` (`@otago/web`, React 19 + Vite, TanStack Query, Vitest). Role: client.
Contract (read-only here): `.claude/features/suggested-prompts/contracts/`. The relevant files are
`suggestions-api.ts` (routes and client rules), `suggestions.ts` (`Suggestion`, `MAX_SUGGESTIONS`,
`suggestionKey`), `errors.ts` (`suggestions_failed`) and `shared.ts` (question body).
Server plan: `.claude/features/suggested-prompts/projects/server/plan.md`. No research file existed;
this plan comes from reading `web/src`.

## Summary of the design

- **Data.** `GET /trees/:tree/suggestions?node=` is a separate query keyed `['suggestions', tree, node]`.
  The server's response is already resolved (target, `up`, own first) and already has "used" items
  removed. The chain query, SSE and the question store are unchanged.
- **Lazy generation.** When a panel's node comes back `state: 'missing'`, the panel POSTs once for
  that (tree, node) per focus or mount. A module-level in-flight map deduplicates the POST across
  panels and StrictMode double effects. On 200 the response goes into the query cache. On 404 or
  502 nothing is shown and nothing is retried until the node is opened again.
- **Visibility.** The client applies these rules on top of the server list:
  - Hide a suggestion when the question store holds an entry for the same tree, with
    `parentId === target` and the same `suggestionKey`. This covers live outbox sends and
    questions of every status, except done-and-acked ones (see "Decisions").
  - In the side panel, hide inherited items whose target lies above the aside's anchor.
  - Apply a defensive own-wins dedup and a cap of 5.
  - Render nothing until the store is hydrated, and nothing while the panel shows an in-flight
    exchange.
- **Click.** `store.ask` goes to `target` with the panel's model choice, `files: []` and the
  panel's context. The outbox is claimed with a no-op claim, so a failure before the 202 never
  writes the draft stash or the composer. `QuestionEffects` still shows the usual "not sent"
  error notice. A synchronous guard on `store.getState()` makes a double click send at most one
  question. The button disappears on the next published frame because the outbox entry hides it.
- **UI.** A `SuggestionList` (a `<nav>` of buttons) is rendered as the footer of the last
  exchange in both chat panels. Labels use `dir="auto"` and are cut by graphemes. Inherited buttons
  carry a "from <name>" source tag (`<bdi>`).

## Decisions (client-only choices the contract leaves to the web)

1. **Side panel and inherited targets above the anchor.** Such targets are hidden in the side
   panel. A target is kept only when `isSameOrDescendant(target, side.anchor)` holds, which
   covers `target === anchor` and an anchor of `''`. Sending with `anchor: target` would create
   an aside the user never opened. Those inherited items are about the main line of study anyway,
   and the main panel still offers them.
2. **Which store entries hide a suggestion.**
   - These entries hide it: outbox entries with `error === null`, and questions that are
     `streaming`, `naming` or `failed`, plus `done` questions that are not acked yet. Failed
     questions keep hiding it because they can be retried, so a duplicate would be confusing.
   - These entries do not hide it: outbox entries with `error !== null` (a "Not sent" draft that
     went back to the composer), and done questions that are acked. Once acked, the node is in
     the refetched tree and the server's "used" filter takes over. If that node is later deleted,
     the suggestion comes back at once instead of waiting up to 30 minutes for the entry to
     expire.
   - To avoid a flicker, `QuestionEffects.onDone` awaits the suggestions refetch together with
     the tree refetch before it acks. This narrows the contract wording "any status"; see "Open
     contract questions".
3. **When a panel shows suggestions.** All of these must hold:
   - The panel's focused saved node is not `''`.
   - The panel has no in-flight view (`inFlight.view === null`). There is no focused question,
     no live send and no "Not sent" entry.
   - The loaded chain ends at that node. `useChain` keeps the previous chain as placeholder data,
     so this check stops buttons of one node from showing under another node's thread.
   - The store is hydrated. Before the first snapshot, questions from other tabs or from before a
     reload are unknown, and clicking would risk a duplicate.

   For the main panel that node is `currentId` with `question === null`. For the side panel it is
   `side.head` with `side.question === null`. With `head === null` the side thread is empty, so
   there is nothing to hang buttons on.
4. **Lazy POST scope.** The query and the lazy POST run for the panel's saved node even while the
   panel shows an in-flight exchange under it, because the node is open. Only rendering is gated.
5. **Display cap.** Labels are cut to `SUGGESTION_LABEL_GRAPHEMES = 120` graphemes with an
   ellipsis (`truncateGraphemes`), and the full text goes in `title`. The server already caps the
   text at 200 graphemes. The question that is sent is always the full `text`, verbatim.
6. **No loading indicator.** Nothing is rendered while the GET or the POST is pending.
   Suggestions are optional, so a spinner under every old node would be noise.

## Files

### New

| Path | Purpose |
|---|---|
| `web/src/lib/suggestions.ts` | Pure logic, no React. Constants `MAX_SUGGESTIONS = 5` and `SUGGESTION_LABEL_GRAPHEMES = 120`. Functions: `suggestionKey(text)` (`trim().normalize('NFC')`, a web copy of the contract function), `inFlightSuggestionKeys(state, tree, targets)`, `visibleSuggestions(list, inFlight, opts)`, `suggestionLabel(text)`, `suggestionSource(s)`, `hasInFlightSuggestion(state, tree, s)` and `askSuggestion(store, input)`. Signatures are below. |
| `web/src/lib/suggestions.test.ts` | Unit tests (see Test plan). |
| `web/src/components/chat/useSuggestions.ts` | Panel hook. It combines the query and lazy POST (`useNodeSuggestions`), the store selector for in-flight keys, the visibility filter and the click handler. It returns `{ items: Suggestion[]; ask: (s: Suggestion) => void }`. |
| `web/src/components/chat/SuggestionList.tsx` | Thin view. Renders `<nav className="suggestions" aria-label={t('suggestions.label')}>` holding one `Button` per item, or `null` when there are none. |
| `web/src/components/chat/SuggestionList.test.tsx` | `renderToStaticMarkup` tests, in the same style as `InFlightExchange.test.tsx`. |

### Changed

| Path | Change |
|---|---|
| `web/src/api/types.ts` | Add `Suggestion { text; target; up }`, `SuggestionsReady`, `SuggestionsMissing`, `SuggestionsResponse` and `SuggestionErrorCode = 'suggestions_failed'`, mirroring contract `suggestions-api.ts`/`suggestions.ts`/`errors.ts`. Extend the `ErrorBody.code` union with `SuggestionErrorCode`. Add the contract path to the header comment. |
| `web/src/api/client.ts` | Two new `api` methods (see "Client API"). Add a `SUGGESTION_ERROR_CODES = ['suggestions_failed']` list to `isErrorCode`, and add `SuggestionErrorCode` to the `ApiErrorCode` union. **No new top-level exports.** |
| `web/src/api/queries.ts` | `keys.suggestions(tree, node)` and `keys.treeSuggestions(tree)`. `generateSuggestionsOnce(queryClient, tree, node)` uses a module-level dedup map. `useNodeSuggestions(tree, node)` is the query plus the lazy trigger. `dropTreeCaches` also drops `'suggestions'`. |
| `web/src/api/queries.test.ts` | Tests for the dedup and the cache (see Test plan). |
| `web/src/api/client.test.ts` | Tests for the two methods and for the error code. |
| `web/src/components/chat/ChatThread.tsx` | New optional props `tail?: ReactNode` and `tailKey?: unknown`. When `tail` is set and `!inFlight`, pass it as `footer` of the **last** message's `Exchange`. Add `tailKey` to the deps of the stick-to-bottom layout effect, so buttons that arrive later (after the lazy POST) stay in view when the reader was at the bottom. |
| `web/src/components/chat/ChatView.tsx` | Call `useSuggestions({ treeId, nodeId: currentId \|\| null, context: MAIN_CONTEXT, stashKey, models: composer.models, show })`. `show = question === null && inFlight.view === null && messages.at(-1)?.id === currentId && !chain.error`. Pass `tail={<SuggestionList items onAsk />}` and `tailKey={items.length}`. |
| `web/src/components/chat/SideChatView.tsx` | Same call with `nodeId: side.head`, the panel's `context` (`{kind:'side', anchor}`), `stashKey: stashKeyOf(tree.id, context)`, `models: composer.models`, and `show = side.question === null && side.head !== null && inFlight.view === null && messages.at(-1)?.id === side.head && !chain.error`. The anchor rule comes from `context`, inside `visibleSuggestions`. |
| `web/src/components/QuestionEffects.tsx` | `onDone`: refetch `keys.tree(tree)` and `keys.treeSuggestions(tree)` together (`Promise.all`, each `.catch(() => undefined)`), then reconcile and ack as today. `onRemoved`, for every non-`restart` event of a known question: `invalidateQueries({ queryKey: keys.treeSuggestions(question.tree) })`. This is cheap because only active queries refetch, and it follows contract "Invalidate … a question … was removed". |
| `web/src/components/graph/GraphView.tsx` | `applyHierarchy` (used by delete, move, rename and undo) also runs `void queryClient.invalidateQueries({ queryKey: keys.treeSuggestions(treeId) })`. Use invalidate, not remove: the active panel query must refetch, and ids or "used" state may have changed. |
| `web/src/i18n/locales/en/chat.ts`, `web/src/i18n/locales/ru/chat.ts` | `suggestions: { label, from, askUnder }`. en: `'Suggested questions'`, `'from <name>{{name}}</name>'`, `'Asks under {{target}}'`. ru: `'Предлагаемые вопросы'`, `'из <name>{{name}}</name>'`, `'Будет задан в «{{target}}»'`. The implementer may polish the wording. Keep the key sets identical. |
| `web/src/styles/base.css` | `.suggestions` is a flex-wrap row with a small gap and a top margin under the answer. `.suggestion` is a pill-like `btn-sm` with left-aligned text, wrapping (`white-space: normal`) and `max-width: 100%`. `.suggestion-source` is muted, smaller and mono, like `.node-link`. Use the existing theme variables only. Do not hand-format; run `pnpm format`. |
| `CLAUDE.md` (repo) | At the end of implement, add one bullet under Web describing `lib/suggestions.ts` and `useSuggestions` (the visibility rules and the no-op outbox claim). |

## Client API (`web/src/api/client.ts`)

Two new members of the exported `api` object. **These are the only additions the demo shim must
mirror.** `demo/src/mock/client.ts` declares `api: typeof Real.api = demo.api`, so `DemoApi` must
implement both, or the demo stops type-checking:

```ts
/** GET: pure read. `state: 'missing'` = node.md has no stored list yet. */
getSuggestions: (id: string, node: string) =>
  request<SuggestionsResponse>(`${tree(id)}/suggestions?node=${encodeURIComponent(node)}`),
/** POST: lazy generation (idempotent, deduped per node on the server; may take up to ~30 s). */
generateSuggestions: (id: string, node: string) =>
  request<SuggestionsReady>(`${tree(id)}/suggestions`, json('POST', { node })),
```

`ApiError` gains no new export. `isErrorCode` now also accepts `'suggestions_failed'`, so a 502
carries `code === 'suggestions_failed'`. `ApiErrorCode` (an exported type) widens by that member.
The demo re-exports the real type, so nothing changes there.

New types live in `api/types.ts`, which is not redirected in the demo: `Suggestion`,
`SuggestionsReady`, `SuggestionsMissing`, `SuggestionsResponse` and `SuggestionErrorCode`.

## Query layer (`web/src/api/queries.ts`)

```ts
keys.suggestions = (tree: string, node: string) => ['suggestions', tree, node] as const;
keys.treeSuggestions = (tree: string) => ['suggestions', tree] as const;

/** One POST per (tree, node) at a time, across panels/tabs-in-this-page/StrictMode. */
const generating = new Map<string, Promise<SuggestionsReady>>(); // key: `${tree}\0${node}`
export function generateSuggestionsOnce(
  queryClient: QueryClient, tree: string, node: string,
): Promise<SuggestionsReady>;
//  - returns the existing promise when one is in flight;
//  - else api.generateSuggestions → on success setQueryData(keys.suggestions(tree, node), r);
//  - `finally` deletes the map entry (success AND failure), so a later open can retry.

/** Suggestions of a saved node: `null` while unknown or missing, else the server's list. */
export function useNodeSuggestions(tree: string, node: string | null): Suggestion[] | null;
//  - useQuery({ queryKey: keys.suggestions(tree, node ?? ''), queryFn: api.getSuggestions,
//      enabled: node !== null && node !== '' })  — NO placeholderData (a previous node's buttons
//      would send to the wrong targets);
//  - lazy trigger: useEffect on [tree, node, data?.state]. When state === 'missing' and the
//    `attempted` ref (one `${tree}\0${node}` string per hook instance) differs, set it, then
//    `void generateSuggestionsOnce(...).catch(() => undefined)`. Since the ref is per mount and
//    keyed by node, a failure is retried only when the node is opened again (another node and
//    back, a remount, or a new id after a move). Invalidation refetches that return 'missing'
//    again do not re-trigger. Never POST for 'ready'.
//  - returns data?.state === 'ready' ? data.suggestions : null.
```

`dropTreeCaches` adds `'suggestions'` to its kinds. `moveTreeCaches` does not seed suggestions,
because chains are not seeded either. The new tree id refetches.

A late POST response for a tree that was renamed meanwhile writes an orphan cache entry under the
old id. Nothing observes it and it is garbage-collected, so no extra handling is needed.

## Pure logic (`web/src/lib/suggestions.ts`)

```ts
export const MAX_SUGGESTIONS = 5;
export const SUGGESTION_LABEL_GRAPHEMES = 120;
export const suggestionKey = (text: string): string => text.trim().normalize('NFC');

/**
 * Sorted unique `${parentId}\0${key}` of store entries that hide a suggestion under one of
 * `targets` in `tree` (Decision 2). Stable strings, so `shallowArrayEqual` works as `equal`.
 */
export function inFlightSuggestionKeys(
  state: QuestionsState, tree: string, targets: readonly string[],
): string[];

/**
 * In order:
 *  1. drop items whose `${target}\0${key}` is in `inFlight`;
 *  2. if `anchor !== null` (side panel), drop items with !isSameOrDescendant(target, anchor);
 *  3. dedupe by key: an own item (up 0) beats an inherited one wherever it appears, otherwise
 *     the first one wins; the order is the server's order (own first);
 *  4. cap at MAX_SUGGESTIONS.
 */
export function visibleSuggestions(
  list: readonly Suggestion[], inFlight: readonly string[], opts: { anchor: string | null },
): Suggestion[];

/** Button text: truncateGraphemes(text, SUGGESTION_LABEL_GRAPHEMES). */
export const suggestionLabel: (text: string) => string;
/** Source tag of an inherited item: nameOf(target); null for own (up === 0). */
export const suggestionSource: (s: Suggestion) => string | null;

/** Synchronous guard against double clicks: reads CURRENT state (`store.getState()`). */
export function hasInFlightSuggestion(state: QuestionsState, tree: string, s: Suggestion): boolean;

/**
 * Click: returns the outbox id, or null when the guard refused. Steps:
 *   if hasInFlightSuggestion(store.getState(), tree, s) → null;
 *   id = store.ask({ tree, parentId: s.target, context, stashKey, text: s.text, files: [],
 *                    model: model ?? undefined, namingModel: namingModel ?? undefined });
 *   store.claimOutbox(id, () => false);   // never released, see below
 *   return id;
 */
export function askSuggestion(store: QuestionStore, input: {
  tree: string; context: QuestionContext; stashKey: string; suggestion: Suggestion;
  model: string | null; namingModel: string | null;
}): string | null;
```

Why the no-op claim matters. Without a claim, `endOutbox` emits `outbox-ended` with
`restored: false`, and `QuestionEffects.onOutboxEnded` then **merges the text into the panel's
draft stash**. That would break "nothing goes into the composer". With the claim, `restored` is
`true` and `shown` is `false`. The stash stays untouched, the failed outbox entry is dropped (no
"Not sent" box), and `onOutboxEnded` still pushes the usual `notices.notSent` error notice with the
title and `describeError(error).message`. A user abort of an own-target send from the panel's
Cancel button works the same way: nothing is restored. The claim is not released on unmount (the
store deletes it on the 202 or at the end), so it holds even if the panel goes away. The `stashKey`
argument is still required by `AskInput` and is passed as the panel's key, but it is never used.

Composer interaction:
- `useComposer` and its draft are not touched.
- An own-target click creates an outbox entry under the panel's parent. `useInFlight` shows it
  exactly like a typed send: the composer locks, and after the 202 `acceptedFocus` focuses the
  question.
- An inherited-target click does not match the panel's parent, so the panel stays where it is.
  The pending box appears under the target in the graph, which is scenario B.
- The panel reads the model choice from its `useComposer().models`, which is already filtered
  against `/models`.

## Panel hook (`web/src/components/chat/useSuggestions.ts`)

```ts
export function useSuggestions(o: {
  treeId: string;
  nodeId: string | null;          // the panel's focused saved node (never '')
  context: QuestionContext;
  stashKey: string;
  models: ModelChoice;            // composer.models
  show: boolean;                  // panel gating (Decision 3)
}): { items: Suggestion[]; ask: (s: Suggestion) => void };
```
- `list = useNodeSuggestions(treeId, nodeId)` and `hydrated = useHydrated()`.
- `targets` is the unique list of targets, memoized. `targetsKey = targets.join('\n')`.
- `inFlight = useStoreSelector((s) => inFlightSuggestionKeys(s, treeId, targets), shallowArrayEqual, [treeId, targetsKey])`.
  The equality is the existing `shallowArrayEqual` from `lib/questions.ts`. Chunks never change
  the result, so streaming text does not re-render the panel through this hook.
- `items = useMemo(() => show && hydrated && list ? visibleSuggestions(list, inFlight, { anchor: context.kind === 'side' ? context.anchor : null }) : [], …)`.
  It returns a stable `EMPTY` constant when there are no items.
- `ask = useCallback((s) => { askSuggestion(store, { tree: treeId, context, stashKey, suggestion: s, model: models.model, namingModel: models.namingModel }); }, [...])`.

## View (`web/src/components/chat/SuggestionList.tsx`)

```tsx
interface SuggestionListProps { items: Suggestion[]; onAsk: (s: Suggestion) => void }
```
- Returns `null` for `items.length === 0`.
- Wraps the buttons in `<nav className="suggestions" aria-label={t('suggestions.label')}>`.
- Each item renders `<Button size="sm" className="suggestion" key={`${s.target}\0${s.text}`} title={full text, plus "\n" + t('suggestions.askUnder', { target }) for inherited items} onClick={() => onAsk(s)}>`.
  Inside the button:
  - `<span dir="auto">{suggestionLabel(s.text)}</span>`.
  - For inherited items, `<span className="suggestion-source"><Trans t={t} i18nKey="suggestions.from" values={{ name }} components={{ name: <bdi dir="auto" /> }} /></span>`.
- No `disabled` state is needed. The synchronous guard refuses a second send, and the button is
  hidden from the next published frame.

## Interface changes

- HTTP: the web starts calling `GET /api/trees/:tree/suggestions?node=` and
  `POST /api/trees/:tree/suggestions` (contract `suggestions-api.ts`). `POST /trees/:tree/questions`
  is used unchanged: JSON body, no files, through `buildQuestionBody`.
- `api` object: adds `getSuggestions` and `generateSuggestions`. The demo must mirror both.
- `ApiErrorCode`: adds `'suggestions_failed'`.
- `ChatThread`: adds the optional props `tail` and `tailKey`.
- Query keys: new `['suggestions', tree, node]` family.
- No change to the question store API, to `lib/questions.ts` reducers, SSE parsing, URL state or
  undo history.

## Step ordering

1. `api/types.ts`: the types and the error code.
2. `api/client.ts`: the two methods and the error code list. Then `api/client.test.ts`.
3. `lib/suggestions.ts` and `lib/suggestions.test.ts`.
4. `api/queries.ts`: the keys, `generateSuggestionsOnce`, `useNodeSuggestions` and
   `dropTreeCaches`. Then `api/queries.test.ts`.
5. i18n keys (en and ru), then `SuggestionList.tsx` and its test, then the CSS.
6. `components/chat/useSuggestions.ts`, then the `ChatThread` `tail`/`tailKey` props, then the
   `ChatView` and `SideChatView` wiring.
7. Invalidation: `QuestionEffects` (done awaits both refetches before ack; removed invalidates)
   and `GraphView.applyHierarchy`.
8. The demo plan lands in the same change. Because of `api: typeof Real.api`, `pnpm lint` at the
   repo root fails until `DemoApi` has `getSuggestions` and `generateSuggestions`.
9. `pnpm format` and `pnpm check`, then `pnpm lint` and `pnpm test` from the repo root.
10. Manual check with `pnpm dev` against the implemented server:
    - An old node gets one POST, and the buttons appear.
    - A reload shows the stored list, with no POST.
    - Clicking an inherited item creates a sibling under the ancestor, and the button disappears.
    - A double click sends one question.
    - In the side panel, inherited items above the anchor are absent.
    - Stopping the server between the GET and the click gives a "not sent" notice and the draft
      is unchanged.
11. Update `CLAUDE.md` (the Web bullet).

## Test plan

No component test infrastructure beyond `renderToStaticMarkup`. Pure logic carries the weight.

### `lib/suggestions.test.ts`
- **`suggestionKey`:**
  - Trims.
  - Treats NFD and NFC Cyrillic `й` and Latin `é` as equal.
  - Is case-sensitive (`'Глава 2'` ≠ `'глава 2'`).
  - Keeps inner whitespace.
- **`inFlightSuggestionKeys`**, built on `initialQuestionsState` with hand-made `questions`,
  `outbox` and `acked`:
  - Includes an outbox entry with `error === null`, in both phases.
  - Excludes an outbox entry with `error !== null`.
  - Includes `streaming`, `naming`, `failed` and done-but-not-acked questions.
  - Excludes done and acked questions.
  - Excludes other trees and parents that are not in `targets`.
  - Key-normalizes the entry text (`'  Глава 2\n'` matches `'Глава 2'`).
  - Returns sorted and unique keys, so repeated calls produce `shallowArrayEqual` arrays.
- **`visibleSuggestions`:**
  - Hides a suggestion that has an in-flight entry under its target, but not one whose entry is
    under a different target with the same text.
  - Side anchor rule:
    - Anchor `''` keeps everything.
    - A target equal to the anchor is kept.
    - A target that is a descendant of the anchor is kept.
    - A target above the anchor is dropped.
    - A sibling-prefix target (`a` vs anchor `ab`) is dropped, which checks the
      `isSameOrDescendant` boundary.
  - Own wins over a duplicate inherited item even when the inherited one comes first in the
    input.
  - Two inherited items with the same key keep the first.
  - Caps at 5 and preserves order.
  - `[]` in gives `[]` out.
- **`suggestionLabel`:**
  - Text of 120 graphemes or less is unchanged.
  - Longer text is cut with `…`.
  - The cut never splits an emoji ZWJ sequence or a combining mark (use `lib/text.ts` fixtures).
- **`suggestionSource`:** `null` for `up: 0`. For `up: 2` on target `план/раздел` it returns
  `раздел`.
- **`askSuggestion`**, with `createQuestionStore` (fake `api`, `schedule` run immediately):
  - Calls `startQuestion` once with `{ parentId: target, text, model, namingModel, context, files: [] }`.
    `null` models become `undefined`.
  - A second call before the 202 returns `null` and makes no second `startQuestion`. The same
    holds after the 202 (question `streaming` in state).
  - The send fails before the 202 (the fake rejects with `ApiError(409, …, 'tree_busy_structural')`):
    the lifecycle `outbox-ended` has `restored: true` and `shown: false`, the outbox entry is
    gone, and `draftStash.get(stashKey)` is unchanged.
  - Aborting with `store.abortOutbox(id)` likewise leaves the stash untouched.

### `api/client.test.ts`
- `getSuggestions('my tree', 'план/глава-1')`:
  - Fetches `/api/trees/my%20tree/suggestions?node=%D0%BF…%2F…`. The node is percent-encoded
    with `encodeURIComponent`, and `/` becomes `%2F`.
  - Returns the body for both the `ready` and the `missing` shapes.
- `generateSuggestions`: sends a POST with the JSON body `{"node":"…"}` and
  `content-type: application/json`.
- Errors:
  - A 502 `{ error, code: 'suggestions_failed' }` gives an `ApiError` with that code, and
    `isApiError(e, 502, 'suggestions_failed')` is true.
  - A 404 `node_not_found` keeps its code.

### `api/queries.test.ts`
- `generateSuggestionsOnce`, with `vi.spyOn(api, 'generateSuggestions')` and a deferred:
  - Two concurrent calls make one API call and resolve to the same value.
  - On success the cache under `keys.suggestions(tree, node)` holds the response.
  - On rejection the cache stays untouched and the next call calls the API again (the map entry
    was cleared).
  - Different nodes, or the same node in different trees, do not share an entry.
- `dropTreeCaches` also removes `['suggestions', old, …]` and keeps other trees' entries. Extend
  the existing "removes every cache of the old id" test.
- `keys.treeSuggestions(tree)` is a prefix of `keys.suggestions(tree, node)`: `invalidateQueries`
  marks a seeded entry as stale.

### `components/chat/SuggestionList.test.tsx`
- Empty items render `''`.
- An own item renders a button whose text has `dir="auto"` and has no `.suggestion-source`.
- An inherited item renders the source tag with `<bdi dir="auto">` holding the last id segment,
  and its `title` contains the full text and the target.
- A long text is truncated in the label, and the full text is in `title`.
- Order is preserved.

### Not unit-tested (manual, step 10)
- The lazy trigger effect inside `useNodeSuggestions`: no DOM testing library is installed. Its
  dedup and cache logic is covered through `generateSuggestionsOnce`.
- The panel gating expressions in `ChatView` and `SideChatView`.
- The invalidation wiring in `QuestionEffects` and `GraphView`.

Existing tests must stay green: `questions.test.ts`, `question-store.test.ts`,
`question-focus.test.ts` and `InFlightExchange.test.tsx`. Neither the reducer nor the focus rules
change.

## Open contract questions

1. **Hiding by done questions.** Contract `suggestions-api.ts` says store entries of "any status
   (streaming, naming, done, failed)" hide a suggestion. The web excludes done questions once they
   are **acked**, because the server's "used" filter covers them after the tree refetch. This lets
   a suggestion come back right after its node is deleted. The web avoids a flicker by awaiting
   the suggestions refetch before the ack. The owner should confirm this, or reword the contract
   to "any status until the created node is acked".
2. **Side panel caveat.** The contract leaves the choice to the web plan. The web **hides**
   inherited items whose target is above the aside's anchor (Decision 1). The contract text could
   record this choice so the demo mock and future clients agree. This does not change the shape.
3. **Unhydrated store.** The contract does not say what to show before the first SSE snapshot.
   The web shows nothing until the store is hydrated, to avoid duplicate questions right after a
   reload. The demo's `mock/connection.ts` must hydrate the store as it does today, or demo
   buttons never appear.
4. **No abort for the lazy POST.** `generateSuggestions` takes no `AbortSignal`. The server does
   not cancel on disconnect and persists the result anyway, so aborting on unmount gains nothing.
   This only needs noting if the contract later adds a cancel semantic.
