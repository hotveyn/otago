# 05 — Messages endpoint (SSE)

**Goal:** `POST /api/trees/:tree/messages` creates a new node from a streamed answer.

## Scope
- Body `{parentId, text}`; `parentId = ""` means root
- SSE events: `chunk` (text), `done` (`{nodeId}`), `error` (`{message}`)
- On success: write node via storage layer (task 02)
- On failure or client disconnect: write nothing, release tree lock
- 409 if tree is locked

## Done when
- Integration test with mocked runner: chunks streamed, node written, id returned
- Integration test: runner error → no folder created
