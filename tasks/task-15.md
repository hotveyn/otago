# Task 15: The riskiest client and retry logic has no tests

Priority: **Should fix** (missing tests). Source: repo audit, 2026-10-17.

## Now

1. Developer: add two server tests for retry preparation in `server/test/question-files-api.test.ts`. About 1 hour.
2. Developer: move the `QuestionEffects` decisions into pure functions in `web/src/lib/` and test them. About 2 hours.

## Short

- `QuestionEffects` orders refetch → navigate → ack on a finished answer; that order prevents the empty-exchange flash.
- It also batches restart notices and puts a send's draft back after `outbox-ended`.
- No test imports `QuestionEffects`; `useTreeUndo` and the GraphView mutation flows are also untested.
- Server: the only retry-preparation test is the concurrent-retry 409.
- Deleting the `preparing.has(id)` guard would let eviction delete held user files, and no test fails.

## Where

- `web/src/components/QuestionEffects.tsx:60-145`
- `server/src/questions/service.ts:122` (`preparing.has` guard)
- `server/src/questions/service.ts:247-251` (DELETE during retry preparation)
- `server/src/questions/service.ts:377-391` (re-hold and abort path)

## Server tests

1. DELETE while `retry()` is paused in preparation: expect 204, the retry 404, the held dir empty.
2. Per-tree eviction during preparation: the held files survive until `prepareRetry` decides.

## Web tests

Pure functions for the `onOutboxEnded` and done-follow decisions, plus one render test of `QuestionEffects` with a fake store.

## Next

Open `server/test/questions-api.test.ts` and find the concurrent-retry test near line 760.
