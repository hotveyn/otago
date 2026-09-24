# 01 — Project scaffold

**Goal:** empty server and web app that build and run.

## Scope
- Repo layout: `server/` (Node.js, Fastify, TypeScript), `web/` (React, TypeScript)
- Scripts: `dev`, `build`, `lint`, `format`, `test` for both
- Server binds `127.0.0.1`, reads `OTAGO_TREES_DIR` (default `./trees`)
- Web dev server proxies `/api` to the server
- `GET /api/health` → `{ok: true}`

## Done when
- `dev` starts both; web page shows health status from the server
- `lint`, `format`, `test` run with zero errors
