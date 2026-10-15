// Disk side of suggested prompts: "used" scans, resolved views, candidates and the verified
// write of .claude/features/suggested-prompts/contracts/generation.ts.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError } from '../errors.js';
import { type NodeFile, parseNodeFile, serializeNodeFile } from './format.js';
import { isErrno, writeFileAtomic } from './fs-utils.js';
import { type ChainNode, liveChildEntries, readChain } from './nodes.js';
import { NODE_FILE, nodeDirOf } from './paths.js';
import {
  nearestStoredIndex,
  pickCandidates,
  resolveSuggestions,
  type StoredSuggestion,
  type SuggestionCandidate,
  type SuggestionChainNode,
  type SuggestionsResponse,
  setSuggestionsLine,
  suggestionKey,
  suggestionTargets,
} from './suggestions.js';

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

/** Resolved view of the chain's last node (`nodeId`), "used" items removed. */
export async function suggestionsViewOf(
  treeDir: string,
  nodeId: string,
  chain: readonly SuggestionChainNode[],
): Promise<SuggestionsResponse> {
  const used = await readUsedKeys(treeDir, suggestionTargets(chain));
  const resolved = resolveSuggestions(chain, used);
  return resolved === 'missing'
    ? { node: nodeId, state: 'missing', suggestions: [] }
    : { node: nodeId, state: 'ready', suggestions: resolved };
}

/** `GET …/suggestions` for one node: read its chain, scan the targets' children, resolve. */
export async function readSuggestionsView(
  treeDir: string,
  nodeId: string,
): Promise<SuggestionsResponse> {
  return suggestionsViewOf(treeDir, nodeId, await readSuggestionChain(treeDir, nodeId));
}

/** Inheritance candidates for a node whose ancestors are `ancestors` (top-level first). */
export async function readCandidates(
  treeDir: string,
  ancestors: readonly SuggestionChainNode[],
  askedKeys: ReadonlySet<string>,
): Promise<SuggestionCandidate[]> {
  const nearest = nearestStoredIndex(ancestors);
  if (nearest === -1) return [];
  const used = await readUsedKeys(treeDir, suggestionTargets(ancestors.slice(0, nearest + 1)));
  return pickCandidates(ancestors, used, askedKeys);
}

/** The part of a node a generation started from; the verified write compares it. */
export interface SuggestionSnapshot {
  created: string;
  user: string;
  assistant: string;
}

/** `snapshot` as `parseNodeFile` will read it back after `serializeNodeFile` (trimmed lines). */
export function storedSnapshot(snapshot: SuggestionSnapshot): SuggestionSnapshot {
  const { created, user, assistant } = parseNodeFile(serializeNodeFile({ ...snapshot, model: '' }));
  return { created, user, assistant };
}

function sameExchange(node: NodeFile, snapshot: SuggestionSnapshot): boolean {
  return (
    node.created === snapshot.created &&
    node.user === snapshot.user &&
    node.assistant === snapshot.assistant
  );
}

/**
 * - `written`: the line was spliced in;
 * - `stored`: another writer stored a list meanwhile (it wins, ours is discarded);
 * - `gone`: no node file at that id any more (moved, renamed, deleted, tree renamed);
 * - `changed`: the file at that id is another exchange now, or unreadable.
 */
export type WriteSuggestionsOutcome = 'written' | 'stored' | 'gone' | 'changed';

/**
 * Verified write: re-read `node.md` at `nodeId`, check it is still the exchange of `snapshot`
 * and still has no list, then splice the suggestions line in (every other byte kept) and
 * replace the file atomically inside the node folder. Never creates directories and takes no
 * lock: a concurrent move/delete makes the write fail with ENOENT (→ `gone`). `signal` is
 * checked right before the write (throws when aborted).
 */
export async function writeNodeSuggestions(
  treeDir: string,
  nodeId: string,
  snapshot: SuggestionSnapshot,
  items: readonly StoredSuggestion[],
  options: { signal?: AbortSignal } = {},
): Promise<WriteSuggestionsOutcome> {
  const file = path.join(nodeDirOf(treeDir, nodeId), NODE_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR', 'EISDIR')) return 'gone';
    throw error;
  }
  let current: NodeFile;
  let next: string;
  try {
    current = parseNodeFile(raw);
    next = setSuggestionsLine(raw, items);
  } catch {
    return 'changed';
  }
  if (!sameExchange(current, snapshot)) return 'changed';
  if (current.suggestions !== undefined) return 'stored';
  options.signal?.throwIfAborted();
  try {
    await writeFileAtomic(file, next);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return 'gone';
    throw error;
  }
  return 'written';
}
