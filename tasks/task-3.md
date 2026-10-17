# Task 3: One bad citation link blanks the whole app

Priority: **Must fix** (crash). Source: repo audit, 2026-10-17.

## Now

1. Developer: replace `decodeURIComponent` with `safeDecode` at `web/src/components/chat/Markdown.tsx:299`. About 2 minutes.
2. Developer: add one test in `web/src/components/chat/Markdown.test.tsx` with `[1](#cite-%zz)`. About 10 minutes.

## Short

- `Anchor` decodes the `#cite-…` href with no try/catch.
- micromark lets `%zz` through, so `decodeURIComponent` throws `URIError` during render.
- There is no React error boundary in `web/src`, so the whole page unmounts.
- The answer is saved: opening that node or any descendant crashes again, even after reload.

## Where

- `web/src/components/chat/Markdown.tsx:299-301`
- `safeDecode` already exists in the same file at `:317`.

## Fix

```ts
const citation = citations.get(safeDecode(href.slice(CITE_HREF_PREFIX.length)));
```

Optional, separate: one error boundary around `<Markdown>`.

## Done when

The new test renders `[1](#cite-%zz)` without throwing.

## Next

Open `web/src/components/chat/Markdown.tsx` at line 299.
