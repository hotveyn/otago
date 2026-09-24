# 10 — Web: node management

**Goal:** delete and move nodes from the graph.

## Scope
- Toolbar for selection: Delete, Move to…
- Delete: confirmation dialog with node count including descendants
- Move to…: pick target node or root
- Drag a node onto another node or root → move (applies to the whole selection if the dragged node is selected)
- Show API errors (invalid move, tree locked)
- If the current node was deleted → current becomes its nearest surviving ancestor; if moved → follow its new id

## Done when
- Multi-select 3 nodes → move under another node → graph and disk match
- Delete a node with children → subtree gone from graph and disk
