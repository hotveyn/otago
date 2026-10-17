# Task 18: README and CLAUDE.md point to folders that don't exist

Priority: **Should fix** (docs). Source: repo audit, 2026-10-17.

## Now

1. Developer: remove or update the dead links in `README.md` and `CLAUDE.md`. About 10 minutes.

## Short

- `docs/design.md`, `docs/backend-stack.md` and the `docs/` folder do not exist.
- `README.md:174` and `:181` describe `tasks/` as the v1 roadmap; this folder now holds the audit tasks instead.
- `CLAUDE.md:5` sends coding agents to read `docs/` files that are missing.

## Where

- `README.md:173-174` (folder list), `:179-181` (links)
- `CLAUDE.md:5` (`docs/design.md`, `docs/backend-stack.md`)
- `CLAUDE.md:78` ("`tasks/` holds the original v1 roadmap")

## Fix

Delete the `docs/` lines. Change the `tasks/` lines to describe the audit tasks, or delete them.

## Next

Open `README.md` at line 173.
