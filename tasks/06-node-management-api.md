# 06 — Node management API

**Goal:** delete and move nodes with subtrees, one or many.

## Scope
- `POST /api/trees/:tree/nodes/delete` `{ids[]}`
- `POST /api/trees/:tree/nodes/move` `{ids[], targetParentId}`
- Skip ids whose ancestor is also in the list
- Reject move into itself or its own descendant (400)
- Name collision at target → `-2` suffix
- 409 while the tree lock is held (task 04)
- Response: updated hierarchy

## Done when
- Tests: single/multi delete, single/multi move, nested selection, invalid move, collision, locked tree
