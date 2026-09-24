# 08 — Web: graph view

**Goal:** render the node hierarchy as a graph and select the current node.

## Scope
- Graph library chosen separately
- Root + nodes as boxes with folder names, edges parent → child, auto layout top-down
- Pan and zoom
- Click → set current node; highlight current node and its chain to root
- Shift/Cmd+click → multi-select (state only; actions in task 10)
- Refresh after hierarchy changes

## Done when
- Tree with ~50 nodes renders readable; clicking nodes updates the current node in the URL
