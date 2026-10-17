# Task 19: Every streamed chunk re-renders the whole chat

Priority: **Nice to have** (speed). Source: repo audit, 2026-10-17.

## Now

1. Developer: extract a memoized `SavedExchange` from `web/src/components/chat/ChatThread.tsx:123-160`. About 45 minutes.

## Short

- While the focused answer streams, ChatView re-renders once per animation frame (`useInFlight.ts:38`).
- Saved `Exchange`s are not memoized and get a new `attachments={{...}}` object each time.
- So every citation chip, attachment link and `formatDate` call in every saved exchange re-runs about 60 times a second.
- With 40+ exchanges in a chain, streaming stutters.
- The streaming answer itself is fully re-parsed each frame (accepted for now).

## Where

- `web/src/components/chat/useInFlight.ts:38`
- `web/src/components/chat/ChatThread.tsx:123-160`
- `web/src/components/chat/Exchange.tsx:45`

## Fix

`const SavedExchange = memo(...)` taking `node`, `treeId`, `current`, `onSelectNode`, `footer`, and building `attachments` and `meta` inside. The tail footer only shows when nothing is in flight, so it does not break the memo while streaming.

## Done when

React DevTools Profiler shows saved exchanges not re-rendering during a stream.

## Next

Open `web/src/components/chat/ChatThread.tsx` at line 123.
