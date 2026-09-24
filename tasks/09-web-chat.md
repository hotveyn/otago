# 09 — Web: chat

**Goal:** chat for the current node's chain with streaming answers.

## Scope
- Load chain on current node change; render user/assistant messages as markdown
- Input + Send → `POST /messages`, stream `chunk` events into a pending message
- On `done`: switch current node to the new id, refresh graph
- On `error`: show error, keep the typed text
- Input disabled while streaming
- Citations `sources/<file>:<lines>` → open source viewer at those lines; URLs open in a new tab
- Current = root → empty chat, send creates a top-level node

## Done when
- Full loop in UI: ask → streamed answer → new node appears in graph and becomes current → click parent → chat shows shorter chain
