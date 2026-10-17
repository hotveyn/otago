# Task 2: Any website can call the local API

Priority: **Must fix** (security). Source: repo audit, 2026-10-17.

## Now

1. Developer: add one `onRequest` hook in `buildApp` (`server/src/app.ts`). About 20 minutes.
2. Developer: add one test for the 403 cases. About 15 minutes.

## Short

- The server binds `127.0.0.1:3001`: other machines can't reach it, but pages in your own browser can.
- The server never checks `Host` or `Origin`.
- DNS rebinding (an attacker domain re-pointed to 127.0.0.1) lets a page read, move and delete trees.
- A cross-site `multipart/form-data` POST needs no preflight: it can start an agent run or upload sources.
- Chrome blocks this (Local Network Access); Safari and Firefox do not.

## Where

- `server/src/app.ts:50-124` (no request guard)
- `server/src/index.ts:42` (`listen` on 127.0.0.1)

## Fix

One `onRequest` hook, replying 403 when:

1. the hostname in `Host` is not `127.0.0.1`, `localhost` or `otago` (the Vite proxy uses `changeOrigin`, so `Host` is the target);
2. `sec-fetch-site` is `cross-site`.

## Done when

- `inject` with `host: evil.example` returns 403.
- `inject` with `sec-fetch-site: cross-site` returns 403.
- `pnpm dev` and the UI still work through the Vite proxy.

## Next

Open `server/src/app.ts` and find where `buildApp` registers routes.
