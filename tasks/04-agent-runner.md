# 04 — Agent runner

**Goal:** server module that takes a chain + new question and streams an answer from the Agent SDK.

## Scope
- System prompt with the rules from the design doc + tree instructions from `tree.md`
- Serialize the chain into the prompt as a transcript
- `query()` with `cwd = trees/<tree>/`, allowed tools: `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`; everything else denied
- Expose answer as an async stream of text chunks + final full text
- Node naming: quick Haiku call → 2–4 word kebab-case name
- Per-tree lock: one running request per tree

## Done when
- Manual script: ask a question in a tree with a source → answer cites `sources/<file>:<lines>`
- Manual script: tree without sources → answer cites URLs
- Unit tests for prompt building and name sanitizing (SDK mocked)
