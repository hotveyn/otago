# 02 — Storage layer

**Goal:** server module that reads and writes the `trees/` filesystem per the design doc. No HTTP.

## Scope
- Parse/serialize `tree.md` (frontmatter + instructions body)
- Parse/serialize `node.md` (frontmatter + `otago:user` / `otago:assistant` sections)
- Read tree hierarchy: node = folder with `node.md`; skip `sources/`, `tree.md`; sort siblings by `created`
- Read chain `root → node`
- Create node atomically (temp dir + rename); kebab-case name, `-2` suffix on collision
- Path safety: reject ids escaping the tree folder (`..`, absolute paths)

## Done when
- Unit tests on a temp dir cover: parse/serialize round-trip, hierarchy, chain, collision suffix, path traversal rejection
