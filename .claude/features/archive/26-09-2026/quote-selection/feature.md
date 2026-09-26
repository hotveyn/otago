# Quote selection in chat

## Summary
The user selects part of any message in the chat. A small "Quote" popup appears next to the selection. Clicking it appends the selected text to the composer as a Markdown blockquote (`> ...`), followed by an empty line, so the user can type a question or clarification about it. Several quotes can be added to one message. Quotes are plain Markdown in the question text; there is no new data model or API.

## Goals
- Quote any selected text from assistant answers **and** user questions.
- Show a floating "Quote" popup anchored to the selection.
- Append the quote to the composer draft as `> ` lines and put the caret after it.
- Allow multiple quotes per message (each appended in order, separated by a blank line).
- Render user questions in the history as Markdown, so quotes show as blockquotes.

## Non-goals
- No server/API changes: the quote is part of the question text.
- No structured quote objects, no link back to the source node (see Future considerations).
- No quoting of non-text content (images, rendered diagrams as graphics). Only the selection's visible text is used.

## Actors
- **User** of the web app, reading a conversation branch (chain of exchanges) in `ChatView`.

## Main scenarios
1. User selects text inside an assistant answer → "Quote" popup appears near the selection end → click → draft gets `> selected text\n\n` appended, composer is focused, caret at the end, selection cleared, popup hidden.
2. User selects text inside one of their own earlier questions → same behavior.
3. User adds a second quote (from the same or another exchange) → it is appended after the existing draft content, separated by a blank line.
4. User types a question below the quotes and sends. The message goes to the **currently selected node** (the composer target), even if the quote came from another node in the chain. As usual, the message creates a new child/branch under that current node.
5. In the history, the question renders as Markdown: quotes show as blockquotes, the rest as formatted text.

## Edge cases
- **Multi-line selection:** every line is prefixed with `> `. Empty lines become `>`, so the quote stays one blockquote.
- **Whitespace-only/empty selection:** no popup.
- **Selection spans several messages/exchanges:** allowed; the visible text is quoted as-is.
- **Selection inside code blocks, tables, Mermaid/CSV blocks:** quoted as plain visible text (`Selection.toString()`), no special handling.
- **Selection outside the chat scroller** (sidebar, graph, composer itself): no popup.
- **Streaming in progress:** quoting is allowed and appends to the draft. The composer is disabled while streaming; sending waits until the stream ends, as it does today.
- **Draft already has text:** the quote is appended at the end (not at the caret), preceded by a blank line if the draft doesn't already end with one.
- **Popup dismissal:** hide on selection collapse, on scroll of the chat, on Escape, on click outside, and on node/tree switch.
- **Keyboard/touch:** popup must be clickable without collapsing the selection first (prevent mousedown default on the button). Touch selection should work where the browser fires `selectionchange`.
- **Markdown in questions (behavior change):** existing questions that contain `*`, `#`, `` ` ``, `|`, `>` will now render as Markdown. Accepted by the user. Line breaks must be kept (single newlines currently shown via `whitespace` class; use `remark-breaks`-like handling or equivalent so old questions don't collapse into one paragraph).
- **Markdown renderer for questions:** reuse the chat `Markdown` component, without assistant-only features that don't apply to user text (attachment scope, streaming caret), or with them disabled safely.

## Constraints (NFR)
- Web only (`web` project); no server contract change.
- No new heavy dependencies; use the native Selection/Range API for positioning (`getBoundingClientRect`).
- Popup must follow existing theme tokens (light/dark themes in `styles/themes.css`).
- Must not break text copy (Ctrl/Cmd+C) or normal selection behavior.
- The `web` package uses Biome; formatting via `pnpm --filter @otago/web format`.

## Future considerations (out of scope, design must allow)
- **More popup actions:** the popup should be a generic "selection actions" menu (a list of actions), with "Quote" as the first. "Copy", "Explain" etc. can be added later without rewriting it.
- **Branching rule stays fixed:** any message creates a new branch. A message with quotes always goes under the **currently selected node**, never under the node the quote came from. Future actions must follow the same rule unless stated otherwise.
- Keep the quote-formatting logic in a pure helper (e.g. `lib/quote.ts`: `toBlockquote(text)`, `appendQuote(draft, text)`) so it can be reused by later actions and unit-tested with vitest.

## Open questions
- None blocking. Popup placement (above vs below selection) and label ("Quote" vs "Цитировать") are left to the plan; the default follows the UI language (currently English → "Quote").
