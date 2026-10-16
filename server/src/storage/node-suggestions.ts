// Disk side of suggestions: "used" scans, resolved views (GET) and the candidates offered to
// the answering agent. Contract: .claude/features/inline-suggestions/contracts/ and
// .claude/features/topic-split-v2/contracts/ ("whole" items target the map's parent, `""` =
// top-level nodes). Suggestions are written only by `createNode` at the commit; nothing here
// writes.
import { InvalidInputError, NotFoundError } from '../errors.js';
import { isErrno } from './fs-utils.js';
import { type ChainNode, liveChildEntries, readChain } from './nodes.js';
import { nodeDirOf, nodeIdSegments } from './paths.js';
import {
  pickCandidates,
  resolveSuggestions,
  type SuggestionCandidate,
  type SuggestionChainNode,
  type SuggestionsResponse,
  suggestionKey,
  suggestionTargets,
} from './suggestions.js';
import { existingTreeDir } from './trees.js';

/** `suggestionKey` of every live child's question of `nodeId` (`""` = top-level nodes). */
export async function readChildQuestionKeys(treeDir: string, nodeId: string): Promise<Set<string>> {
  try {
    const children = await liveChildEntries(nodeDirOf(treeDir, nodeId), nodeId);
    return new Set(children.map((child) => suggestionKey(child.node.user)));
  } catch (error) {
    // Moved or deleted meanwhile: nothing under it is "used".
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return new Set();
    throw error;
  }
}

/** Children question keys for each of `targets`. */
export async function readUsedKeys(
  treeDir: string,
  targets: readonly string[],
): Promise<Map<string, Set<string>>> {
  const used = new Map<string, Set<string>>();
  for (const target of targets) used.set(target, await readChildQuestionKeys(treeDir, target));
  return used;
}

/** Chain from the top-level node down to `nodeId`; 404 `node_not_found` when it is gone. */
export async function readSuggestionChain(treeDir: string, nodeId: string): Promise<ChainNode[]> {
  try {
    return await readChain(treeDir, nodeId);
  } catch (error) {
    if (error instanceof NotFoundError || isErrno(error, 'ENOENT', 'ENOTDIR')) {
      throw new NotFoundError(`Node not found: ${nodeId}`, 'node_not_found');
    }
    throw error;
  }
}

/** Resolved view of the chain's last node (`nodeId`, ancestor fallback), "used" removed. */
export async function suggestionsViewOf(
  treeDir: string,
  nodeId: string,
  chain: readonly SuggestionChainNode[],
): Promise<SuggestionsResponse> {
  const used = await readUsedKeys(treeDir, suggestionTargets(chain));
  return { node: nodeId, state: 'ready', suggestions: resolveSuggestions(chain, used) };
}

/** `GET …/suggestions` for one node: read its chain, scan the targets' children, resolve. */
export async function readSuggestionsView(
  treeDir: string,
  nodeId: string,
): Promise<SuggestionsResponse> {
  return suggestionsViewOf(treeDir, nodeId, await readSuggestionChain(treeDir, nodeId));
}

/**
 * Open suggestions offered to the agent answering a new node whose ancestors are `ancestors`
 * (top-level first; `[]` for a top-level question): what the parent shows, minus `askedKeys`.
 */
export async function readCandidates(
  treeDir: string,
  ancestors: readonly SuggestionChainNode[],
  askedKeys: ReadonlySet<string>,
): Promise<SuggestionCandidate[]> {
  if (ancestors.length === 0) return [];
  const used = await readUsedKeys(treeDir, suggestionTargets(ancestors));
  return pickCandidates(ancestors, used, askedKeys);
}

/**
 * `GET /trees/:tree/suggestions?node=`: 404 for an unknown tree, 400 for the tree root or a
 * malformed id, 404 `node_not_found` for a missing node, else the resolved view. No lock.
 */
export async function viewSuggestions(
  treesDir: string,
  tree: string,
  nodeId: string,
): Promise<SuggestionsResponse> {
  const treeDir = await existingTreeDir(treesDir, tree);
  if (nodeId === '') throw new InvalidInputError('The tree root has no suggestions');
  nodeIdSegments(nodeId);
  return readSuggestionsView(treeDir, nodeId);
}
