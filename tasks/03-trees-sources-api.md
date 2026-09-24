# 03 — Trees & sources API

**Goal:** HTTP endpoints for trees and sources.

## Scope
- `GET /api/trees`, `POST /api/trees`, `GET /api/trees/:tree`, `PATCH /api/trees/:tree`
- `GET /api/trees/:tree/chain?node=<id>`
- `GET|POST /api/trees/:tree/sources`, `GET|DELETE /api/trees/:tree/sources/:file`
- Sources: only `.md` / `.txt` / `.pdf` and e-books (`.epub`, `.fb2`, `.fb2.zip`, `.mobi`, `.azw`, `.azw3`, text extracted to `<book>.md`); reject other extensions and unsafe filenames
- Errors: 404 unknown tree/node, 400 invalid input

## Done when
- Integration tests for each endpoint against a temp trees dir
