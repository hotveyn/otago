# Task 9: `pnpm build` restarts the app and can kill other projects

Priority: **Must fix** (kills in-flight answers and unrelated processes). Source: repo audit, 2026-10-17.

## Now

1. Developer: delete the `postbuild` line from the root `package.json:10`. About 1 minute.
2. Developer: narrow the `pkill` patterns in `down.sh:39-40`. About 10 minutes.

## Short

- Every root build, even one only to type-check, runs `restart.sh`.
- A restart loses every running question and the in-memory registry.
- In the `up.sh` setup, `restart.sh` runs `down.sh`.
- `down.sh` runs `pkill -f "node dist/index.js"` and `pkill -f "vite preview"` across the whole machine.

## Where

- `package.json:10` (`"postbuild": "./restart.sh"`)
- `restart.sh:9-25`
- `down.sh:39-40`

## Fix

1. Remove `postbuild`; run `./restart.sh` by hand after a build when wanted.
2. Start the server with an absolute path (`node "$PWD/server/dist/index.js"`) in `up.sh` and match that path in `pkill`, or drop the leftover-kill lines.

## Done when

- `pnpm build` does not restart anything.
- `./down.sh` leaves a `node dist/index.js` from another folder running.

## Next

Open the root `package.json` at line 10.
