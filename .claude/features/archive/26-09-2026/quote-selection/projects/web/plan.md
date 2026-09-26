# Plan: quote-selection — project `web`

Standalone web-only feature. No contract, no server change, no data-model change. A quote is plain
Markdown (`> ...`) in the question text.

## 0. Findings from the codebase (what the plan relies on)

- `web/src/components/chat/ChatView.tsx` owns `draft` (`useState`), the scroller
  (`scroller` ref on `.chat-scroll`), and `send()`. `send()` reads `currentId` at send time and
  posts with `parentId = currentId`. `Composer` gets `target={currentId}`. Quoting never changes
  `currentId`, so **a quoted message always goes under the currently selected node**. This is
  the rule from feature.md; no change is needed, only a regression note in the test plan.
- `ChatView` is mounted with `key={tree.data.id}` in `App.tsx`, so switching trees remounts it
  (popup state is dropped for free). Switching nodes changes the `currentId` prop, and the popup
  must be hidden explicitly then.
- `Composer.tsx` keeps its own `textarea` ref. It is `disabled={streaming}` and focuses itself in an
  effect when `streaming` becomes false. It has no imperative API yet. `value` is controlled, so
  changing the draft while streaming updates the disabled textarea. That is the behavior we want.
- `Exchange.tsx` renders the question as `<p className="whitespace">{question}</p>` **outside** the
  `AttachmentScope.Provider`, and the answer as `<Markdown text={answer} streaming={streaming} />`
  inside it.
- `Markdown.tsx` already has a `plain` prop ("Hide the sources list, e.g. for the user's own
  messages"). It skips `extractCitations`, so there are no citation chips and no source list.
  - `streaming` defaults to `false`. With `false`, mermaid/csv fences always try to render, and no
    caret is drawn (the caret lives in `Exchange`, not in `Markdown`).
  - With no `AttachmentScope` provider (scope `null`), `attachments/<x>` links show a
    "pending" chip and images show `BrokenAttachment`. Neither crashes. Users do not normally
    write these, so this is acceptable (see Risks).
  - `sources/<file>:<n>` links and external links still work. They are harmless in user text.
  - The root element is `<div className="md">`.
- `remark-breaks` is **not** installed. Only `remark-gfm` and `react-markdown` are. Plan: **no new
  dependency**. mdast keeps soft line breaks as `\n` inside paragraph text nodes, and
  react-markdown emits them as literal `\n`. CSS `white-space: pre-line` on the paragraphs of user
  messages shows them as line breaks. This is the "equivalent handling" the feature allows. (If
  review prefers real `<br>`, the fallback is adding `remark-breaks` (~1 KB,
  `mdast-util-newline-to-break`) to `remarkPlugins` for questions only. It is not in the default
  plan.)
- Tests: vitest in the **node** environment (no jsdom/happy-dom). The existing component test
  (`Markdown.test.tsx`) uses `renderToStaticMarkup`. So DOM Selection logic cannot be unit-tested
  without adding jsdom, which we **will not** add. We keep all logic we can in pure helpers and
  test those. The DOM glue is verified manually.
- Styles: every color is a token from `styles/themes.css` (`--surface`, `--line-strong`,
  `--text`, `--accent`, `--accent-soft`, `--shadow-drag`, `--radius`, ...). CSS import order is
  `themes.css`, `base.css`, `markdown.css`, `graph.css`.
  - `base.css` has `.msg-user p { margin: 0; }`. This rule would squash paragraph spacing inside
    the new Markdown question, so it must go.
  - z-indexes in use: 1, 10, 20 (splitter, source viewer).
- Biome (root `biome.json`): single quotes, trailing commas, width 100, recommended rules. Format
  with the command, never by hand.

## 1. Files

### Create

1. `web/src/lib/quote.ts`: pure quote formatting, with no DOM or React.
   - `toBlockquote(text: string): string`
     - Normalize `\r\n` and `\r` to `\n`. Replace ` ` with a space. Browsers put NBSP into
       `Selection.toString()` from rendered HTML.
     - Remove leading and trailing blank lines. Trim trailing whitespace on each line.
     - Collapse runs of 2 or more empty lines into one. This keeps a single `>` separator line.
     - Map each line: empty → `>`, otherwise → `> ${line}`. Join with `\n`.
     - Return `''` for empty or whitespace-only input.
   - `appendQuote(draft: string, text: string): string`
     - `const quote = toBlockquote(text)`. If `quote === ''`, return `draft` unchanged.
     - If `draft.trim() === ''`, return `${quote}\n\n`. A whitespace-only draft is replaced.
     - Otherwise choose a separator so there is exactly one blank line before the quote:
       - draft ends with `\n\n` → `''`
       - draft ends with `\n` → `'\n'`
       - otherwise → `'\n\n'`
     - Return `draft + separator + quote + '\n\n'`. The trailing blank line is needed: without
       it, the text the user types next would be a lazy continuation of the blockquote.
   - `isQuotable(text: string): boolean` = `text.trim() !== ''`. The popup and the action share
     this check.
2. `web/src/lib/quote.test.ts`: unit tests (see §4).
3. `web/src/lib/popup-position.ts`: pure placement math, unit-testable.
   - `interface Box { top: number; left: number; width: number; height: number }`. Plain numbers,
     so tests do not need `DOMRect`.
   - `placePopup(anchor: Box, popup: { width: number; height: number }, bounds: Box, gap = 6): { top: number; left: number; placement: 'above' | 'below' }`
     - Put the popup **above** the anchor, horizontally centred on it:
       `top = anchor.top - popup.height - gap`.
     - If that goes above `bounds.top`, flip it **below**: `top = anchor.top + anchor.height + gap`.
     - Clamp `left` to `[bounds.left + 4, bounds.left + bounds.width - popup.width - 4]`.
     - Clamp `top` to the bounds as well (a very tall selection end near the edges).
   - Decision: above-first, because a popup below the selection end would cover the next lines
     the user is reading.
4. `web/src/lib/popup-position.test.ts`: unit tests (see §4).
5. `web/src/components/chat/SelectionActions.tsx`: a generic "selection actions" popup.
   - Exported types:
     ```ts
     export interface SelectionAction {
       id: string;
       label: string;
       /** Receives the selection's visible text (Selection.toString()). */
       run: (text: string) => void;
     }
     interface SelectionActionsProps {
       /** Only selections fully inside this element open the popup. */
       container: RefObject<HTMLElement | null>;
       actions: SelectionAction[];
       /** Changing this value hides the popup (e.g. currentId on node switch). */
       resetKey?: unknown;
     }
     ```
   - Internal state: `{ text: string; top: number; left: number } | null`.
   - **Reading the selection** (`readSelection()`):
     - `const sel = document.getSelection()`. Stop if `!sel`, `sel.isCollapsed`, or
       `sel.rangeCount === 0`.
     - Require both `container.current.contains(sel.anchorNode)` and
       `container.current.contains(sel.focusNode)`. This covers selections in the sidebar,
       graph, or composer, and selections that only partly overlap the chat. A selection across
       several exchanges is fine, because both ends are inside the scroller.
     - `text = sel.toString()`. Stop if `!isQuotable(text)`.
     - Anchor rect: `range = sel.getRangeAt(0)`. Use the last non-empty rect of
       `range.getClientRects()` (the selection end). Fall back to `range.getBoundingClientRect()`.
       If the result is zero-sized, hide.
     - Bounds: `container.current.getBoundingClientRect()`. If the anchor rect is outside the
       bounds vertically (the end is scrolled out of view), hide.
     - Popup size: measure the rendered popup via its own ref after the first render
       (`useLayoutEffect`). Before measuring, use a fallback size (e.g. 80×30), then correct it
       in the layout effect so there is no visible jump.
   - **When to evaluate**:
     - `document` `selectionchange`, debounced. Schedule with `requestAnimationFrame` plus a
       short timeout (~120 ms) and cancel the previous one. While the pointer is held down, do
       not show: track `pointerdown`/`pointerup` on the container and evaluate on `pointerup`.
       This prevents flicker while dragging. Touch selection handles are native UI, so they only
       fire `selectionchange`, which the debounce covers.
     - A collapsed or invalid selection hides the popup immediately (no debounce).
   - **Dismissal** (all hide the popup and do not change the selection):
     - selection collapses or becomes invalid: `selectionchange`;
     - scroll of the container: `scroll` listener on `container.current` (passive);
     - `Escape`: `keydown` on `document`. The popup stays hidden until the next
       `selectionchange`;
     - click outside: `pointerdown` on `document` whose target is not inside the popup. The
       selection usually collapses as well;
     - node switch: `useEffect` on `resetKey`;
     - tree switch: `ChatView` remounts;
     - window `resize`: hide.
   - **Rendering**:
     - `createPortal` into `document.body`, so ancestor overflow/transform cannot clip the popup.
     - `<div className="selection-actions" role="toolbar" aria-label="Selection actions" style={{ top, left }}>`
     - One `<button type="button" className="selection-action">` per action.
     - Each button calls `event.preventDefault()` in **both** `onMouseDown` and `onPointerDown`.
       Clicking must not collapse the selection or steal focus. `onClick` does:
       `action.run(state.text)`, then `document.getSelection()?.removeAllRanges()`, then hide.
     - Render nothing when the state is `null`. The container listens only while mounted.
   - Copy (Ctrl/Cmd+C) is not affected: the component never prevents default on key or copy
     events and does not modify the selection until an action is clicked.
   - The action list is data, so "Copy", "Explain", etc. can be added later by passing more
     entries. The component itself does not change.

### Change

6. `web/src/components/chat/Composer.tsx`
   - Add an exported handle type:
     `export interface ComposerHandle { focusEnd: () => void }`
   - Add prop `ref?: Ref<ComposerHandle>`. React 19 accepts `ref` as a plain prop on function
     components, so no `forwardRef` is needed. Use
     `useImperativeHandle(ref, () => ({ focusEnd }), [])`.
   - `focusEnd` sets `wantEnd.current = true` (a `useRef(false)`). It does not focus directly,
     because the new `value` has not been committed yet when the action runs.
   - Add `useLayoutEffect` on `[value, streaming]`: if `wantEnd.current && !streaming` and the
     textarea exists:
     - `focus()`;
     - `setSelectionRange(len, len)`;
     - `scrollTop = scrollHeight`;
     - `wantEnd.current = false`.
   - While streaming the textarea is disabled and cannot be focused, so the flag stays set. When
     the stream ends, the same effect (deps include `streaming`) focuses the textarea and puts
     the caret at the end.
   - The existing `useEffect(() => { if (!streaming) focus() }, [streaming])` stays. The new
     layout effect runs before it, and they agree.
   - No visual change.
7. `web/src/components/chat/ChatView.tsx`
   - `const composer = useRef<ComposerHandle>(null);` and pass `ref={composer}` to `<Composer>`.
   - `const quote = useCallback((text: string) => { setDraft((d) => appendQuote(d, text)); composer.current?.focusEnd(); }, []);`
     This uses a functional update, so it works while streaming and with stale closures.
   - `const selectionActions = useMemo<SelectionAction[]>(() => [{ id: 'quote', label: 'Quote', run: quote }], [quote]);`
     "Quote" is first. The label is English to match the current UI language.
   - Render `<SelectionActions container={scroller} actions={selectionActions} resetKey={currentId} />`
     once, inside `.chat`, e.g. right after the `.chat-scroll` div. It is portalled anyway.
   - `send()` is unchanged: `parentId = currentId`. Add a one-line comment near `quote` to record
     the rule: "Quotes only edit the draft; the message still goes under `currentId`."
8. `web/src/components/chat/Exchange.tsx`
   - Replace `<p className="whitespace">{question}</p>` with
     `<Markdown text={question} plain />`.
   - Keep it **outside** `AttachmentScope.Provider`, as it is today, so answer attachments are
     not resolved from user text.
   - `plain` turns off citation extraction and the source list. `streaming` stays at its
     default `false`, so there is no streaming fence gating. The caret stays answer-only.
   - Question text is short, so `Markdown`'s `memo` keeps re-renders cheap during streaming (the
     question prop does not change).
9. `web/src/components/chat/Markdown.tsx`
   - No API change is required. Only update the doc comment of `plain` to say it is the mode for
     user questions ("no citations/source list; line breaks kept via `.msg-user .md p` CSS").
10. `web/src/styles/base.css`
    - Remove `.msg-user p { margin: 0; }`. It only served the old `<p className="whitespace">`.
      `.md > :last-child` already removes the trailing margin.
    - Add:
      ```css
      /* User questions render as Markdown; keep single newlines as line breaks. */
      .msg-user .md p { white-space: pre-line; }
      .msg-user .md { line-height: 1.5; }
      .msg-user .md blockquote { margin-bottom: 0.6em; }
      ```
      `.whitespace` (`white-space: pre-wrap`): grep shows `Exchange.tsx` was its only user, so
      after this change it is unused. Keep it as a generic utility; removing it is optional
      cleanup.
    - Add the popup styles, in a new `/* ---------- Selection actions ---------- */` section:
      ```css
      .selection-actions {
        position: fixed; z-index: 30; display: flex; gap: 2px; padding: 2px;
        background: var(--surface); border: 1px solid var(--line-strong);
        border-radius: var(--radius); box-shadow: var(--shadow-drag);
        font-size: 13px; user-select: none;
      }
      .selection-action {
        border: 0; background: none; color: var(--text); padding: 3px 9px;
        border-radius: var(--radius); cursor: pointer;
      }
      .selection-action:hover, .selection-action:focus-visible {
        background: var(--accent-soft); color: var(--accent);
      }
      ```
      Use tokens only. No new tokens, so `themes.css` and `theme.test.ts` are untouched.
    - Write these by hand as part of implementation, then run the formatter.
11. `web/src/components/chat/Markdown.test.tsx`: add cases (see §4).

### Not touched

- `web/src/api/*`: no contract or API change.
- `web/package.json`: no new dependencies.
- `styles/themes.css`, `styles/markdown.css`: the blockquote style is reused as is.

## 2. Data model / interface changes

- Data model: none. The quote is part of `text` in `sendMessage`.
- Internal TS interfaces:
  - `ComposerHandle` (new, exported from `Composer.tsx`), plus the `ref` prop on `Composer`;
  - `SelectionAction` (new, exported from `SelectionActions.tsx`);
  - pure helpers in `lib/quote.ts` and `lib/popup-position.ts`.
- No generated files. There is no codegen step.

## 3. Step order

1. `lib/quote.ts` + `lib/quote.test.ts`. Run `pnpm --filter @otago/web test`.
2. `lib/popup-position.ts` + test.
3. `Exchange.tsx` question → `<Markdown plain>`, plus the CSS for `.msg-user .md`. Remove
   `.msg-user p`. Add Markdown tests for questions.
4. `Composer.tsx` `ComposerHandle` / `focusEnd`.
5. `SelectionActions.tsx` + popup CSS.
6. Wire it in `ChatView.tsx`.
7. `pnpm --filter @otago/web format`, then `lint`, `test`, `build`. Then run the manual checks
   below.

## 4. Test plan

### Unit (vitest, node env)

`lib/quote.test.ts`:
- `toBlockquote('hello')` → `'> hello'`.
- Multi-line: `'a\nb'` → `'> a\n> b'`.
- An empty line in the middle becomes `>`: `'a\n\nb'` → `'> a\n>\n> b'`.
- Runs of blank lines collapse: `'a\n\n\n\nb'` → `'> a\n>\n> b'`.
- CRLF and NBSP are normalized. Trailing spaces are trimmed per line.
- Leading and trailing blank lines are stripped: `'\n\n a \n\n'` → `'>  a'`. Only the trailing
  whitespace of a line is trimmed; leading indentation is kept, which matters for code.
- Whitespace-only input → `''`.
- `appendQuote('', 'x')` → `'> x\n\n'`.
- `appendQuote('   \n', 'x')` → `'> x\n\n'`.
- `appendQuote('Q', 'x')` → `'Q\n\n> x\n\n'`.
- `appendQuote('Q\n', 'x')` → `'Q\n\n> x\n\n'`.
- `appendQuote('Q\n\n', 'x')` → `'Q\n\n> x\n\n'`.
- Two quotes in a row: `appendQuote(appendQuote('', 'a'), 'b')` → `'> a\n\n> b\n\n'`. These are
  two separate blockquotes.
- `appendQuote('Q', '   ')` → `'Q'` (unchanged).
- `isQuotable`: `''`, `' \n\t'` → false; `' a '` → true.

`lib/popup-position.test.ts`:
- Enough room above → `placement: 'above'`, horizontally centred.
- Anchor near the top of the bounds → flips `'below'`.
- Anchor near the left or right edges → `left` is clamped inside the bounds.

`components/chat/Markdown.test.tsx` (`renderToStaticMarkup`, `plain`):
- A question with `> quoted\n\nask` renders a `<blockquote>` and a following `<p>ask</p>`.
- `line one\nline two` renders one `<p>` whose text contains `\n`. This proves the soft break
  survives, so the `pre-line` CSS keeps it on screen.
- `plain` with a `[^1]` footnote renders no `Sources` aside.

### Manual (browser, `pnpm --filter @otago/web dev` plus the server)

1. Select a word in an answer. "Quote" appears above the selection end. Click it:
   - the draft gets `> word` and a blank line;
   - the composer is focused with the caret at the end;
   - the selection is cleared and the popup is gone.
2. Same inside an earlier user question.
3. Quote a second fragment: it is appended after a blank line. Type a question and send.
   - The new node is created under the **currently selected node** (see `Reply under <id>`),
     even when the quote came from an ancestor exchange.
   - The question shows blockquotes in the history.
4. Multi-line selection, and a selection that spans two exchanges: every line is prefixed, and
   empty lines show as `>`.
5. Selections inside a code block, a table, and a rendered mermaid/csv block: plain visible text
   is quoted.
6. No popup for: a whitespace-only selection, a selection in the sidebar, the graph, or the
   composer textarea, and a selection that starts in the chat and ends outside it.
7. Dismissal: scroll the chat, press Escape, click elsewhere, switch node via a crumb or the
   graph, switch tree, resize the window.
8. During streaming: quote → the disabled composer shows the appended text. When the stream
   ends, the composer is focused with the caret at the end. Send still waits for the stream.
9. Ctrl/Cmd+C on a selection still copies while the popup is shown.
10. Old questions with single newlines still show on separate lines. Questions with `*`, `#`,
    `` ` `` now render as Markdown (accepted behavior change).
11. Light, dark, and cool themes: the popup uses theme colors.
12. Touch (mobile emulation or a real device): long-press selection shows the popup, and tapping
    "Quote" works.

## 5. Verification commands

```sh
pnpm --filter @otago/web format
pnpm --filter @otago/web lint     # biome check . && tsc --noEmit
pnpm --filter @otago/web test     # vitest run
pnpm --filter @otago/web build    # tsc --noEmit && vite build
```

## 6. Future-consideration seams (not implemented)

- More actions: pass more `SelectionAction` entries (e.g. `{ id: 'copy', ... }`). The component
  already renders a list.
- Every action's `run` gets only the text. The target node is never taken from the selection, so
  future actions inherit the "always under `currentId`" rule by default.
- `lib/quote.ts` is pure and reusable, e.g. for an "Explain" action that pre-fills
  `appendQuote(draft, text) + 'Explain this.'`.

## 7. Risks / notes

- **Line breaks via CSS `pre-line`, not `<br>`.** On screen they look the same, and
  `Selection.toString()` honours `pre-line`, so quoting and copying keep the newlines. Two
  limitations:
  - tight list items without `<p>` do not get `pre-line`, so a soft break inside a list item
    joins with a space. This case is rare in old questions;
  - several blank lines collapse into one paragraph gap.
  If this is not enough, add `remark-breaks` for questions only (a tiny dependency).
- **Markdown behavior change for old questions** (`#`, `*`, `1.` at a line start, `|` tables,
  `<html>` shown as text) is accepted in feature.md. Raw HTML stays escaped: react-markdown has
  no `rehype-raw`, so this is XSS-safe.
- User text containing `attachments/x` links renders a "pending" chip or a "not found" image,
  because there is no attachment scope. It is harmless and rare. Option: pass a scope of `null`
  explicitly. It already is `null`.
- Mermaid/csv fences in questions will now render as diagrams/tables. That is consistent with
  the "reuse Markdown" requirement.
- If the user deletes the blank line after a quote and types right below it, Markdown treats
  that line as a lazy continuation of the blockquote. This is standard Markdown behavior and not
  handled.
- The popup has z-index 30, above the source viewer (20). If the viewer is open over the chat, a
  selection underneath it is not reachable anyway. The `contains` check plus the bounds check
  keep the popup tied to a visible chat selection.
- DOM selection glue has no automated test, because the test environment is node and adding
  jsdom is out of scope. Manual steps cover it.
