import './env.js';
import { createClaudeAgent } from './agent/index.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp({
  treesDir: config.treesDir,
  agent: createClaudeAgent(),
  models: config.models,
  allowPrivateUrls: config.allowPrivateUrls,
  logger: true,
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Trees dir: ${config.treesDir}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
