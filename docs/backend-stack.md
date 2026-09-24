# Otago — Backend Stack

Runtime: Node.js 22+

## Dependencies

| Library | Purpose |
|---|---|
| `fastify` | HTTP server |
| `zod` | Schemas and validation |
| `fastify-type-provider-zod` | Zod schemas in Fastify routes: request/response validation + types |
| `@anthropic-ai/claude-agent-sdk` | LLM agent |
| `gray-matter` | Frontmatter parse/serialize for `node.md` and `tree.md` |
| `@fastify/multipart` | Source file uploads |

## Dev dependencies

| Library | Purpose |
|---|---|
| `typescript` | Language |
| `tsx` | Run TypeScript without a build step |
| `vitest` | Tests |

## Decisions

- **Filesystem:** `fs/promises` only. No `fs-extra`.
  - Atomic node create: `mkdtemp` + `rename`. Temp dir lives inside `trees/` to avoid `EXDEV` across devices.
  - Move subtree: `rename`.
  - Delete subtree: `rm(path, { recursive: true })`.
  - Walk tree: `readdir(path, { withFileTypes: true })`.
- **SSE:** written directly to `reply.raw`. No plugin.
- **No file watcher** (`chokidar`) in v1: the server reads files on every request.
