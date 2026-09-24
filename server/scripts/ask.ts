/**
 * Manual check for the agent runner (task 04). Streams an answer to stdout; writes nothing to
 * the tree (attachments go to a temp folder that is removed at the end).
 *
 *   pnpm --filter @otago/server ask <tree> "<question>" [parentNodeId]
 *
 * Reads OTAGO_* from the environment or `server/.env`; uses the local Claude Code login.
 */
import os from 'node:os';
import '../src/env.js';
import { createClaudeAgent } from '../src/agent/index.js';
import { loadConfig } from '../src/config.js';
import { createAnswerStaging, existingTreeDir, readChain, readTree } from '../src/storage/index.js';

const [treeId, question, parentId = ''] = process.argv.slice(2);
if (!treeId || !question) {
  console.error('Usage: ask <tree> "<question>" [parentNodeId]');
  process.exit(1);
}

const config = loadConfig();
const agent = createClaudeAgent();
const treeDir = await existingTreeDir(config.treesDir, treeId);
const tree = await readTree(config.treesDir, treeId);
const chain = await readChain(treeDir, parentId);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
const staging = await createAnswerStaging({
  parentDir: os.tmpdir(),
  signal: controller.signal,
  allowPrivateUrls: config.allowPrivateUrls,
  onEvent: (event) => console.error(`\n[attachment] ${JSON.stringify(event)}`),
});

const name = agent.name({ question, model: config.models.naming, signal: controller.signal });
for await (const event of agent.ask({
  treeDir,
  instructions: tree.instructions,
  chain,
  question,
  model: config.models.answer,
  signal: controller.signal,
  staging,
})) {
  if (event.type === 'chunk') process.stdout.write(event.text);
  else console.log(`\n\n--- done (${event.model}), ${event.text.length} chars`);
}
console.log(`--- node name: ${await name}`);
console.log(`--- attachments: ${JSON.stringify(await staging.list())}`);
await staging.discard();
