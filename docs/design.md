# Otago — Design Doc v1

## Goal

Personal web app for learning through conversation with an LLM. Conversations branch as a tree. Everything lives in plain files, so the whole thing can be pushed to git.

## Scope

**In v1**
- Web UI: tree list, graph view of the tree, chat
- Create a learning tree, add text sources and custom instructions to it
- Chat where each exchange is a node; nodes branch
- Node management: delete and move nodes, one or many at a time
- Answers are grounded in tree sources; fall back to web search when sources are missing

**Out of v1**
- Quizzes, calendars, learning plans, notifications
- Multi-user, auth, remote hosting
- Editing the text of existing nodes
- Automatic context management (summarizing, trimming). The user manages context by shaping the tree.
- Non-text sources (video, images, scanned books)

## Architecture

```
Browser (React SPA)  ──HTTP/SSE──▶  Node.js server (Fastify, TypeScript)  ──▶  Claude Agent SDK
                                          │
                                          ▼
                                    trees/ (filesystem = single source of truth)
```

- **Frontend:** React, TypeScript
- **Backend:** Node.js, Fastify, TypeScript, `@anthropic-ai/claude-agent-sdk`
- **Storage:** filesystem only. No database. Server rebuilds state by reading folders.
- Runs locally, binds `127.0.0.1`. Uses the local Claude Code login.
- Backend libraries: [backend-stack.md](backend-stack.md). Frontend libraries are chosen separately.

## Filesystem layout

```
trees/                          # root, path set by OTAGO_TREES_DIR
  rust-basics/                  # a tree = root folder
    tree.md                     # tree meta + instructions
    sources/                    # learning materials (.md, .txt, .pdf, e-books)
      the-book-ch4.md
      rust-book.epub            # e-book as uploaded
      rust-book.epub.md         # its text, extracted by the server on upload
    ownership/                  # a node
      node.md
      borrowing-rules/          # child node
        node.md
      move-semantics/
        node.md
    lifetimes/
      node.md
```

Rules:
- A **node** is any folder containing `node.md`.
- Folder name = node name in UI. Kebab-case, unique among siblings (`-2` suffix on collision).
- `sources/` and `tree.md` are reserved names inside a tree folder.
- Node **id** = path relative to the tree folder, e.g. `ownership/borrowing-rules`.
- Sibling order = `created` from frontmatter.

### `tree.md` format

```md
---
title: Rust basics
created: 2026-09-23T10:00:00Z
---
Answer in Russian. I know C++, compare with it where useful.
```

- Body = tree instructions. Appended to the system prompt on every request. May be empty.

### `node.md` format

```md
---
created: 2026-09-23T10:00:00Z
model: claude-opus-5-5
---
<!-- otago:user -->
What is borrowing?

<!-- otago:assistant -->
Borrowing lets you reference a value without taking ownership [^1].

[^1]: sources/the-book-ch4.md:120-134
```

- HTML comment markers split question/answer; they stay invisible when rendered on GitHub.
- Citations are footnotes: `sources/<file>:<lines>` or a URL.

### E-book sources

`.epub`, `.fb2`, `.fb2.zip`, `.mobi`, `.azw`, `.azw3` are binary, so on upload the server extracts the book to Markdown next to it: `<book>.md` (e.g. `rust-book.epub.md`). The agent searches and cites that file; the UI lists the pair as one source and opens the text. Deleting the book deletes the text. DRM-protected, HUFF/CDIC-compressed MOBI and image-only books are rejected with 400.

## Context building

When the user sends a message at node `N`:

1. Collect the chain `root → … → N` (read each `node.md`).
2. Build the prompt: system prompt + tree instructions + serialized transcript of the chain + new user message.
3. Run `query()` from the Agent SDK with `cwd = trees/<tree>/`.
4. Stream the answer to the browser.
5. On success: create folder `N/<name>/node.md` atomically (write to temp dir, then rename).
6. On failure: write nothing; the UI shows the error.

Stateless by design: every request rebuilds context from files. No SDK session reuse, no summarizing. Long chains are the user's job: they move or delete nodes.

**Node naming:** a separate quick call (Haiku) turns the question into a 2–4 word kebab-case name.

## Agent config

- **Allowed tools:** `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`
- **Denied:** `Write`, `Edit`, `Bash`. Only the server writes files.
- **System prompt rules:**
  1. Search `sources/` first for every factual claim.
  2. Cite every fact: source file + lines, or URL.
  3. If `sources/` is empty or has nothing relevant, use web search and say so.
  4. If sources conflict with the web, trust sources and flag the conflict.
  5. Teach: explain, give examples, check understanding.
  6. Follow tree instructions from `tree.md`.

## Node management

- **Delete:** removes the node folder with all descendants. Confirmation required. Permanent; git is the backup.
- **Move:** moves the node folder with all descendants under a new parent (another node or tree root). Descendants' context changes accordingly.
- **Multi-select:** delete or move several nodes at once. If a selected node's ancestor is also selected, the node is skipped (it moves/dies with the ancestor).
- Invalid moves are rejected: into itself or its own descendant.
- Name collision at target → `-2` suffix.
- Blocked while a message is streaming in the same tree.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/trees` | List trees |
| POST | `/api/trees` | Create tree `{title, instructions}` |
| GET | `/api/trees/:tree` | Tree meta + node hierarchy (names, ids, no content) |
| PATCH | `/api/trees/:tree` | Update `{title, instructions}` |
| GET | `/api/trees/:tree/chain?node=<id>` | Messages of node + all ancestors |
| POST | `/api/trees/:tree/messages` | `{parentId, text}` → SSE stream; final event returns new node id |
| POST | `/api/trees/:tree/nodes/delete` | `{ids[]}` → delete nodes with subtrees |
| POST | `/api/trees/:tree/nodes/move` | `{ids[], targetParentId}` → move nodes with subtrees |
| GET | `/api/trees/:tree/sources` | List sources |
| GET | `/api/trees/:tree/sources/:file` | Source content |
| POST | `/api/trees/:tree/sources` | Upload source file (e-books get an extracted `.md` text) |
| DELETE | `/api/trees/:tree/sources/:file` | Remove source |

`parentId` / `targetParentId` = `""` means tree root.

## UI

```
┌──────────────┬───────────────────────┬──────────────────────┐
│ Trees        │ Graph                 │ Chat                 │
│ • rust-basics│      (root)           │ (chain root → node)  │
│ • go-intro   │      /    \           │                      │
│ + new tree   │  [own]   [life]       │                      │
│              │   /  \                │                      │
│ Sources      │ [bor] [mov]           │                      │
│ the-book.md  │                       │ [ input ]    [Send]  │
│ + upload     │ [Delete] [Move to…]   │                      │
└──────────────┴───────────────────────┴──────────────────────┘
```

- **Left:** tree list, tree settings (title, instructions), sources of the current tree.
- **Graph:** nodes as boxes, edges parent → child. Pan and zoom. Current node highlighted.
  - Click → node becomes current, chat re-renders its chain.
  - Shift/Cmd+click → multi-select. Toolbar: Delete, Move to…
  - Drag a node onto another node or root → move.
- **Chat:** messages of the chain. Send → new child of current node, UI switches to it.
  - Current = root → empty chat; sending creates a top-level node.
  - Citations render as links that open the source at the cited lines.
  - One request at a time per tree; input disabled while streaming.
