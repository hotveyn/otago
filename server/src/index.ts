import './env.js';
import { createClaudeAgent } from './agent/index.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { sweepHeldRoots } from './storage/index.js';

/** Max time a graceful shutdown may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const app = await buildApp({
  treesDir: config.treesDir,
  agent: createClaudeAgent(),
  models: config.models,
  allowPrivateUrls: config.allowPrivateUrls,
  logger: true,
});

// Files of failed questions left behind by a crashed process.
await sweepHeldRoots().catch((error: unknown) => app.log.error(error));

// Ends the event streams, stops running answers (their staging is discarded) and removes the
// held files of this process.
let closing = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  app.log.info(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  app.close().then(
    () => process.exit(0),
    (error: unknown) => {
      app.log.error(error);
      process.exit(1);
    },
  );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Trees dir: ${config.treesDir}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
