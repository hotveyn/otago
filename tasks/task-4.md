# Task 4: A question containing the answer marker corrupts its node

Priority: **Must fix** (data corruption). Source: repo audit, 2026-10-17.

## Now

1. Developer: make `parseNodeFile` match markers only as whole lines (`server/src/storage/format.ts:83-98`). About 20 minutes.
2. Developer: add a round-trip test. About 10 minutes.

## Short

- `node.md` splits question and answer at `<!-- otago:assistant -->`.
- The parser takes the first copy of that marker anywhere after the user marker.
- Asking "What does `<!-- otago:assistant -->` mean?" saves a question that reads only "What does".
- The rest of the question is sent to the agent as part of its own previous answer.
- The serializer already writes markers on their own lines, so a line-anchored match fixes it.

## Where

- `server/src/storage/format.ts:83-98` (`parseNodeFile`)
- `server/src/storage/format.ts:105` (`serializeNodeFile`)
- Writer: `server/src/questions/runner.ts:201-210` (saves `job.text` unescaped)

## Fix

Search for `/^<!-- otago:user -->$/m` and then `/^<!-- otago:assistant -->$/m` after the user marker line. A user line that is exactly the marker stays a known limit; mark it with a `shortcut:` comment.

## Done when

`parseNodeFile(serializeNodeFile({ user: 'What does <!-- otago:assistant --> mean?', ... }))` returns the same `user` and `assistant`.

## Next

Open `server/src/storage/format.ts` at line 83.
