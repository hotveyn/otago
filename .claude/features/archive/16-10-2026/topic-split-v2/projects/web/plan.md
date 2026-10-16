# Web plan: topic-split-v2

Project `web` (`web/`, React 19 + Vite + TanStack Query, TypeScript). Client.
Contract: `.claude/features/topic-split-v2/contracts/` (owner: server). This plan follows
`suggestions.ts` (`Suggestion.kind`, `target` may be `""`), `shared.ts` (question body,
`context` rule) and `suggestions-api.ts` (client rules). No new route, query key, SSE event
or store state.

## Summary
- Mirror `Suggestion.kind?: 'whole'` in `web/src/api/types.ts`. `target` may now be `""`, but only for `whole`.
- `visibleSuggestions`:
  - drops items with an unknown `kind`;
  - keeps the "whole" item out of the own-beats-inherited dedupe;
  - always places it last, keeping at most one.
- `SuggestionList` renders the "whole" item as a distinct, last button. It has an accent dashed border and a small "whole topic" tag, with no "from …" source tag. Its tooltip names where it is asked, and the tree root has its own wording.
- Click: the "whole" item is sent through the same guarded `askSuggestion` path. Right after the send is queued, the panel that was clicked (main or side) moves to the target, which is the map node's parent. That panel shows the outbox box at once, and the existing `acceptedFocus` / `reconcileFocus` then focus the question on the 202 and follow it to the saved node. Nothing in `QuestionEffects` changes.

## Answer to open question 3 (research, web)
Today a suggestion click whose target is not the viewed node does **not** move focus:
- `askSuggestion` → `store.ask` creates an outbox entry with `parentId = target`.
- The panel's `useInFlight` only shows the outbox of its own parent (`useOutboxFor(tree, context, parentId)`). The main panel's parent is `url.node`; the side panel's is `sideParent(side)` = `head ?? anchor`. So the box is not shown in the panel.
- On the 202, `QuestionEffects` → `acceptedFocus(liveUrl, question)` focuses only when the panel still targets the question's parent. For the main panel that means `url.node === parentId && url.question === null`; for the side panel, the same anchor, `sideQ` null and `sideParent(side) === parentId`. For an ancestor target that check fails and returns `null`, so the question only appears as a pending box in the graph.

So focus for "whole" is new behaviour. The smallest correct mechanism is to **move the panel to the target first**. After that, all the existing machinery applies unchanged:
- `useOutboxFor` shows the box immediately ("sending" phase);
- `acceptedFocus` sets `q` / `sideQ` on the 202;
- `reconcileFocus` follows the done-and-acked question to its node (main: `node = nodeId`; side: `head = nodeId`, valid because the new node lies under the anchor).

A store-level "focus on accept" flag alone would not show the box before the 202, and it would duplicate `acceptedFocus`.

## Decisions (web-owned)
1. **Look**:
   - The "whole" button is the last button of the same `SuggestionList` `<nav>`. It uses the same `Button size="sm"` with the extra class `suggestion-whole`: a dashed `--accent-line` border and `--accent` text, with the existing hover.
   - After the label it has a small mono tag `suggestions.whole` ("whole topic" / "вся тема"), styled like `.suggestion-source`.
   - It never gets the "from …" source tag (it is not inherited).
   - Tooltip: the full text plus a newline plus `suggestions.askUnder` with the target id. For the root (`""`) it uses the new `suggestions.askAtRoot` ("Asks as a new top-level question" / "Будет задан как новый вопрос верхнего уровня").
2. **Placement**: last, enforced by the web (`visibleSuggestions` partitions), even though the server already stores and resolves it last.
3. **Which items move focus**: only `kind === 'whole'` (`suggestionMovesFocus`). Regular inherited items keep today's behaviour, where the question appears only in the graph. Extending focus to inherited items later is a one-line change to that predicate, but it is out of scope here.
4. **History**:
   - The click navigates with **push** (a user action), so Back returns to the map node.
   - The 202 focus is the existing push in `QuestionEffects`, and the follow to the saved node is the existing replace.
   - Resulting stack: `V` → `P` → `P?q=id` (replaced by the saved node).
5. **Send failure before the 202** (for example `tree_busy_structural`): the panel stays at `P`, and the existing "Not sent" notice shows (the no-op claim means the draft is never touched). It does not navigate back automatically; Back returns to the map. This is accepted to keep the flow simple.
6. **Order inside the click**:
   1. `askSuggestion` queues the send (double-click guard first);
   2. `store.flush()` publishes the new outbox entry;
   3. the panel navigates.

   This way the first render at `P` already shows the box and never flashes `P`'s own suggestions (the same reason `QuestionEffects` flushes before navigating on `accepted`).

## Files to change

### 1. `web/src/api/types.ts`
- Add `export type SuggestionKind = 'whole';` with a comment: open union, mirrors contract `BlockItemKind`, and an unknown value must not be rendered.
- `Suggestion`:
  - add `kind?: SuggestionKind` (doc: absent = regular; `'whole'` = "explain it whole", sent to `target` = the map node's parent, and the panel follows it);
  - update the `target` doc: "the viewed node or an ancestor; `""` (tree root) only for `kind: 'whole'` on a top-level node";
  - update the `up` doc: "`whole` always has `up: 1` but is not inherited".
- `SuggestionsReady.suggestions` doc: "Own regular, then inherited, then at most one `whole` item (last)".

### 2. `web/src/lib/suggestions.ts` (pure)
- Header comment: add the `topic-split-v2` contract path.
- New exports:
  - `isWholeSuggestion(s: Suggestion): boolean` → `s.kind === 'whole'`.
  - `isKnownSuggestion(s: Suggestion): boolean` → `s.kind === undefined || s.kind === 'whole'`. Compare through `(s.kind as string | undefined)`, so a runtime value outside the type is handled.
  - `suggestionMovesFocus(s: Suggestion): boolean` → `isWholeSuggestion(s)` (decision 3).
- `visibleSuggestions(list, inFlight, { anchor })`, new steps:
  1. drop `!isKnownSuggestion(item)`;
  2. in-flight hide (UNCHANGED, `entryKey(target, text)`, works for `target === ''`);
  3. side anchor rule (UNCHANGED `isSameOrDescendant(item.target, anchor)`; a root anchor `''` keeps everything, including `target ''`);
  4. regular items (`kind === undefined`): the own-beats-inherited dedupe UNCHANGED, with `ownKeys` built from regular `up === 0` items only;
  5. "whole" items: excluded from step 4 (neither in `ownKeys` nor `seen`, so they are never dropped as "inherited"). Keep the first one, append it after the regular result.
  Update the doc comment with the new steps.
- `suggestionSource(s)`: return `null` when `s.kind !== undefined` (a "whole" item gets no source tag). Otherwise UNCHANGED.
- `AskSuggestionInput`: add optional `moveFocus?: (parentId: string) => void` (doc: "the panel's move to `parentId`; called for items that move focus, after the send is queued").
- `askSuggestion(store, input)`:
  - after `store.claimOutbox(id, () => false)`, if `input.moveFocus && suggestionMovesFocus(suggestion)`, call `store.flush()` then `input.moveFocus(suggestion.target)`;
  - return `id` as before;
  - when the double-click guard refuses (`null`), never move.

### 3. `web/src/lib/question-focus.ts` (pure)
- New export `sendFocusTarget(url: UrlState, context: QuestionContext, parentId: string): Partial<UrlState> | null`: the patch that makes the panel of `context` target `parentId` with no focused question, so its outbox box and then the 202 focus (`acceptedFocus`) show there. `null` = nothing to change, or no such panel.
  - Main: `url.node === parentId && url.question === null` → `null`; otherwise `{ node: parentId, question: null }`.
  - Side: `null` when `url.side` is null, `url.side.anchor !== context.anchor`, or `!isSameOrDescendant(parentId, anchor)` (that send would break the aside's context; `visibleSuggestions` already hides such items).
    - Otherwise `head = headFor(parentId, anchor)` (null when `parentId === anchor`). If it equals the current head and `side.question === null` → `null`; else `{ side: { anchor, head, question: null } }`.
  - Idempotent: applying the patch makes it return `null`.
- Import `isSameOrDescendant` from `./tree`. `headFor` is already local.

### 4. `web/src/components/chat/useSuggestions.ts`
- `SuggestionsOptions`: add `onMoveFocus: (context: QuestionContext, parentId: string) => void`. Doc: "move this panel to `parentId` (App: `sendFocusTarget` + navigate)".
- `ask`: pass `moveFocus: (parentId) => onMoveFocus(context, parentId)` into `askSuggestion`. Add `onMoveFocus` to the `useCallback` deps.
- `targets` already include `''` when the list has a root-target "whole" item. `inFlightSuggestionKeys` handles it (`wanted.has('')`). No change.

### 5. `web/src/components/chat/ChatView.tsx` and `SideChatView.tsx`
- New prop `onMoveFocus: (context: QuestionContext, parentId: string) => void`, passed through to `useSuggestions`. Nothing else changes.
- The stash key is `stashKeyOf(tree, context)` (it does not depend on the node), so the composer draft survives the move. `SideChatView` keeps its `key` (`tree:anchor`), so it does not remount.

### 6. `web/src/App.tsx`
- One stable callback:
  ```ts
  const moveFocus = useCallback((context: QuestionContext, parentId: string) => {
    const patch = sendFocusTarget(liveUrl(), context, parentId);
    if (patch) navigate(patch);
  }, [navigate]);
  ```
  Pass it as `onMoveFocus` to both `ChatView` and `SideChatView`. It reads the live URL, following the "async handlers read the live URL" rule.
- `QuestionEffects`: no change.

### 7. `web/src/components/chat/SuggestionList.tsx`
- For each item:
  - `const whole = isWholeSuggestion(item)`;
  - `className={whole ? 'suggestion suggestion-whole' : 'suggestion'}`;
  - the label stays `<span dir="auto">{suggestionLabel(item.text)}</span>` (grapheme cut).
- For `whole`, append `<span className="suggestion-kind">{t('suggestions.whole')}</span>` (no source tag: `suggestionSource` returns null).
- Title:
  - regular own: `item.text`;
  - inherited: UNCHANGED;
  - whole: `${item.text}\n${item.target === '' ? t('suggestions.askAtRoot') : t('suggestions.askUnder', { target: item.target })}`.
- React key: `${item.kind ?? ''}\0${item.target}\0${item.text}`.
- The component receives already-filtered items in order. It does not filter by kind itself, because `visibleSuggestions` already dropped unknown kinds.

### 8. `web/src/styles/base.css`
- Do not hand-format; run `pnpm format` afterwards.
- `.suggestions .suggestion-whole`: `border-style: dashed; border-color: var(--accent-line); color: var(--accent);`.
- `.suggestion-kind`: the same as `.suggestion-source` (`flex-shrink: 0; font-family: var(--mono); font-size: 9.6px; color: var(--muted);`). Selector-share it with `.suggestion-source`.
- The existing hover rule applies unchanged.

### 9. `web/src/i18n/locales/en/chat.ts`, `ru/chat.ts`
- `suggestions.whole`: `'whole topic'` / `'вся тема'`.
- `suggestions.askAtRoot`: `'Asks as a new top-level question'` / `'Будет задан как новый вопрос верхнего уровня'`.
- `ru` keeps `satisfies Messages<typeof en>`, so a missing key fails `tsc`.

### 10. Docs: root `CLAUDE.md`, Web "Suggested questions" bullet
Add one sentence. An item may carry `kind: 'whole'` (topic-split-v2): it targets the map node's parent (`""` = root), is shown last and styled distinctly, and is never deduped as inherited. Unknown kinds are not rendered. Its click (`askSuggestion` with `moveFocus`) moves the clicked panel to the target via `sendFocusTarget` (main: `node`; side: `head`), so the outbox box shows at once and the existing `acceptedFocus` / `reconcileFocus` focus and follow it.

## Data model changes
None in the web. There is no new store state, URL parameter, sessionStorage key or query key. `Suggestion` gains an optional field.

## Interface changes
- Internal props: `ChatView` / `SideChatView` gain `onMoveFocus`; `SuggestionsOptions` gains `onMoveFocus`; `AskSuggestionInput` gains optional `moveFocus`.
- New pure exports:
  - `isWholeSuggestion`, `isKnownSuggestion`, `suggestionMovesFocus` (`lib/suggestions.ts`);
  - `sendFocusTarget` (`lib/question-focus.ts`).
- HTTP usage: unchanged body `{ parentId: target, text, model, namingModel, context, files: [] }`, where `parentId` may be `''`.

## Demo note (not this project's work)
The demo builds this web code as-is and swaps only `api/client.ts`. Once the demo mock returns `kind: 'whole'` items (demo plan), the button, the dedupe and the focus move work there without web changes. Keep `SuggestionKind` in `api/types.ts` (the shim must keep exporting everything the client exports, and the type lives in `types.ts`, not `client.ts`).

## Step order
1. `api/types.ts`: `SuggestionKind` and `Suggestion.kind`, plus doc updates.
2. `lib/suggestions.ts`: predicates, `visibleSuggestions`, `suggestionSource`, `askSuggestion` `moveFocus`, plus tests.
3. `lib/question-focus.ts`: `sendFocusTarget` plus tests (including composition with `acceptedFocus` / `reconcileFocus`).
4. i18n keys (en, ru), `SuggestionList.tsx`, CSS, plus `SuggestionList.test.tsx`.
5. Wiring: `useSuggestions.ts` → `ChatView.tsx` / `SideChatView.tsx` → `App.tsx`.
6. `CLAUDE.md` web bullet.
7. `pnpm format`, `pnpm --filter @otago/web lint`, `pnpm --filter @otago/web test`, then `pnpm test` (all packages, because the demo builds web).
8. Manual check with `pnpm dev` once the server part lands, or `pnpm demo` once the demo part lands:
   - top-level map: the "whole" click switches the main panel to the root, the box shows, then it follows to the new top-level node;
   - nested map in the main panel: switches to the parent;
   - map as a side head: the side moves to its parent (or to `head = null` when the parent is the anchor), and the main panel is untouched;
   - after save, Back to the map: no "whole" button.

## Test plan (vitest, colocated; no testing-library; components via `renderToStaticMarkup`)

### `web/src/lib/suggestions.test.ts`
Add a helper `whole(text, target = 'план')` → `{ text, target, up: 1, kind: 'whole' }`.
- `visibleSuggestions`:
  - an unknown kind (`{ ..., kind: 'extra' } as unknown as Suggestion`) is dropped; regular items around it stay in order;
  - a "whole" item whose text equals an own item's text is kept (not dropped as inherited), and the own item is kept too;
  - a "whole" item is not removed by a preceding inherited duplicate either, and it does not hide an inherited item with the same text;
  - a "whole" item given first in the list is returned last; regular items keep their order;
  - two "whole" items: only the first is kept, placed last;
  - in-flight: `key('', W)` hides a root-target "whole" item; `key('план', W)` hides a nested one; a key under another target does not hide it;
  - side anchor:
    - anchor `'а/б'` with a "whole" item targeting `'а/б'` (map head `а/б/в`) is kept;
    - a target `'а/б/в'` is kept;
    - a target `'а'` (above) is dropped;
    - root anchor `''` with target `''` is kept;
  - the existing cases still pass unchanged.
- `isKnownSuggestion` / `isWholeSuggestion` / `suggestionMovesFocus`:
  - regular → known, not whole, does not move;
  - whole → known, whole, moves;
  - unknown kind → not known, not whole, does not move.
- `suggestionSource`: null for a "whole" item (including target `''`, which must not yield `''`).
- `inFlightSuggestionKeys` with target `''`: an outbox entry and a running question with `parentId: ''` are found.
- `askSuggestion` (existing `setup()` with a real store):
  - "whole" with `target: ''` in a main context:
    - `startQuestion` gets `parentId: ''`, the text and `files: []`;
    - `moveFocus` is called once with `''`;
    - when it is called, `store.getSnapshot()` already contains the outbox entry (flushed);
  - "whole" with `target: 'план'` in a side context with anchor `'план'`: `moveFocus('план')` is called, and the body has the side context;
  - a regular own / inherited item with `moveFocus` given: never called;
  - a second click (guard returns `null`): `moveFocus` is not called again, and `startQuestion` is called once;
  - without `moveFocus` (optional): a "whole" item sends normally.
  Check against `question-store.ts` that `getSnapshot` is the published state; otherwise assert the call order with a `flush` spy.

### `web/src/lib/question-focus.test.ts` (new `describe('sendFocusTarget')`)
- Main:
  - `url({ node: 'основы/карта' })`, `sendFocusTarget(url, MAIN, 'основы')` → `{ node: 'основы', question: null }`; to `''` → `{ node: '', question: null }`;
  - already at the parent with no question → `null`;
  - idempotent (merge with `mergeUrlState`, call again → `null`).
- Side:
  - side `{ anchor: 'а', head: 'а/б/карта', question: null }`:
    - parent `'а/б'` → `{ side: { anchor: 'а', head: 'а/б', question: null } }`;
    - parent `'а'` (the anchor) → head `null`;
  - parent above the anchor (`''` with anchor `'а'`) → `null`;
  - other anchor in context → `null`; no side → `null`;
  - the main state (`node`, `question`) is untouched by a side patch;
  - idempotent.
- Composition (the whole flow on pure functions):
  - Main: `url1 = mergeUrlState(url0, sendFocusTarget(url0, MAIN, 'основы'))`. Then `acceptedFocus(url1, running('a', { parentId: 'основы' }))` → `{ question: 'a' }`. Then `reconcileFocus(url2, state([done('a')], { acked: { a: true } }))` → `{ node: 'основы/новый', question: null }`.
  - Main, root: the same with `parentId: ''`, a top-level map node and `nodeId: 'новый'`.
  - Side:
    - the same with a side context: accepted → `sideQ` set; done and acked → `head = nodeId`, and `isValidHead` holds because the node lies under the anchor;
    - with `parentId === anchor` (head `null`), `acceptedFocus` still matches (`sideParent` = anchor).
  - Without the move (today's behaviour, regression guard): `acceptedFocus(url0, running('a', { parentId: 'основы' }))` with `url0.node = 'основы/карта'` → `null`.

### `web/src/components/chat/SuggestionList.test.tsx`
- A "whole" item renders `class="suggestion suggestion-whole"`, `<span dir="auto">…</span>` and `<span class="suggestion-kind">whole topic</span>`, with no `suggestion-source`.
- Title for target `'план'`: `"W\nAsks under план"`; for target `''`: `"W\nAsks as a new top-level question"`.
- A long "whole" text is cut by graphemes (`SUGGESTION_LABEL_GRAPHEMES`) and the full text stays in the title.
- Mixed list `[own, inherited, whole]`: three buttons in this order; only the inherited one has `suggestion-source`.

### `web/src/i18n/i18n.test.ts`
- `ru('suggestions.whole')` → `'вся тема'`, and English for an unknown language → `'whole topic'` (optional; `tsc` already enforces the keys).

### Not unit-tested (thin wiring, covered by `tsc` and the manual check)
`useSuggestions` passing `onMoveFocus`, the props of `ChatView` / `SideChatView`, and the `App.moveFocus` callback.

## Risks and notes
- If the server returns "whole" before the server part lands (or never), nothing changes for the user: the web code handles lists without `kind` byte-for-byte as today.
- Moving the main panel also moves the graph selection (`GraphView currentId = url.node`) to the parent. This is intended: the pending box sits under it.
- The panel's composer now targets `P`. That is expected (the panel moved), and the draft is kept because the stash key is per tree + context.
