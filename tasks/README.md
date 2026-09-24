# Tasks — v1

Spec: [../docs/design.md](../docs/design.md)

| # | Task | Depends on |
|---|---|---|
| 01 | [Project scaffold](01-scaffold.md) | — |
| 02 | [Storage layer](02-storage.md) | 01 |
| 03 | [Trees & sources API](03-trees-sources-api.md) | 02 |
| 04 | [Agent runner](04-agent-runner.md) | 02 |
| 05 | [Messages endpoint (SSE)](05-messages-endpoint.md) | 03, 04 |
| 06 | [Node management API](06-node-management-api.md) | 03 |
| 07 | [Web: layout, trees, sources](07-web-layout.md) | 03 |
| 08 | [Web: graph view](08-web-graph.md) | 07 |
| 09 | [Web: chat](09-web-chat.md) | 05, 08 |
| 10 | [Web: node management](10-web-node-management.md) | 06, 08 |

Server track: 01 → 02 → 03/04 → 05/06. Web track starts after 03.
