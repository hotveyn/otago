/**
 * Manual check for the agent runner (task 04). Streams an answer to stdout through the same
 * suggestion block filter as the server (the block is never printed inline), then prints the
 * open suggestions offered, the node name and the parsed / finalized suggestions. Writes nothing
 * to the tree (attachments go to a temp folder that is removed at the end).
 *
 *   pnpm --filter @otago/server ask <tree> "<question>" [parentNodeId]
 *
 * Reads OTAGO_* from the environment or `server/.env`; uses the local Claude Code login.
 */
import os from 'node:os';
import '../src/env.js';
import { createClaudeAgent } from '../src/agent/index.js';
import { loadConfig } from '../src/config.js';
import {
  createAnswerStaging,
  existingTreeDir,
  finalizeSuggestions,
  readCandidates,
  readChain,
  readTree,
  SuggestionBlockFilter,
  splitSuggestionBlock,
  suggestionKey,
} from '../src/storage/index.js';

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

// Like the runner: the parent's open suggestions (read-only scan).
const askedKeys = new Set([...chain.map((node) => node.user), question].map(suggestionKey));
const candidates = await readCandidates(treeDir, chain, askedKeys);
const openSuggestions = candidates.map((candidate) => candidate.text);

let answer = '';
let doneLine = '';
const filter = new SuggestionBlockFilter();
for await (const event of agent.ask({
  treeDir,
  instructions: tree.instructions,
  chain,
  question,
  files: [],
  openSuggestions,
  model: config.models.answer,
  signal: controller.signal,
  staging,
  stagingDir: staging.dir,
})) {
  if (event.type === 'chunk') process.stdout.write(filter.push(event.text));
  else {
    answer = event.text;
    doneLine = `--- done (${event.model}), ${event.text.length} chars`;
  }
}
process.stdout.write(filter.end());
console.log(`\n\n${doneLine}`);
if (openSuggestions.length > 0) {
  console.log(`--- open suggestions offered: ${JSON.stringify(openSuggestions)}`);
}
const split = splitSuggestionBlock(answer);
// Like the server: the name is chosen after the answer, from the question and the answer.
const name = await agent.name({
  question,
  answer: split.answer,
  model: config.models.naming,
  signal: controller.signal,
});
console.log(`--- node name: ${name}`);
if (split.items === undefined) {
  console.log('--- suggestions: none (no block)');
} else {
  console.log(`--- suggestions block: ${JSON.stringify(split.items)}`);
  const stored = finalizeSuggestions(split.items, candidates, { depth: chain.length, askedKeys });
  console.log(`--- suggestions stored: ${JSON.stringify(stored)}`);
}
if (split.rejected) {
  console.log('--- warning: suggestions marker kept in the answer (not a valid final block)');
}
console.log(`--- attachments: ${JSON.stringify(await staging.list())}`);
await staging.discard();
