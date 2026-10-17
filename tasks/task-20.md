# Task 20: An empty `.env` value gives a wrong default

Priority: **Nice to have**. Source: repo audit, 2026-10-17.

## Now

1. Developer: change `??` to `||` on two lines in `server/src/config.ts:33-34`. About 2 minutes.
2. Developer: add two cases to `server/test/config.test.ts`. About 10 minutes.

## Short

- `OTAGO_PORT=` gives `Number('')` = 0: the server listens on a random port and the Vite proxy to 3001 fails.
- `OTAGO_TREES_DIR=` resolves to `server/` itself as the trees folder.
- `loadModels` already uses `||` for the same reason.

## Where

`server/src/config.ts:33-34`

## Fix

```ts
port: Number(env.OTAGO_PORT || 3001),
treesDir: path.resolve(SERVER_DIR, env.OTAGO_TREES_DIR || './trees'),
```

## Done when

`loadConfig({ OTAGO_PORT: '', OTAGO_TREES_DIR: '' })` returns port 3001 and `server/trees`.

## Next

Open `server/src/config.ts` at line 33.
