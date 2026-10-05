/**
 * Per-tree undo history of structural edits (move, delete). Pure: storage and API are injected.
 * Entry model mirrors .claude/features/tree-undo/contracts/history.ts.
 *
 * Renames (rename-trees-nodes) record nothing: a node rename remaps the stack (`remapHistory`
 * with the `renamed` map), a tree rename moves the stack to the new tree id (`renameHistoryKey`).
 */
import { ApiError } from '../api/client';
import type { HierarchyNode, MoveResult, RestoreResult, TrashId } from '../api/types';
import { i18n } from '../i18n';
import { describeError } from './chat-errors';
import type { KeyValueStore } from './storage';
import { nameOf, parentIdOf } from './tree';

type NodeId = string;
/** `old → new` id rewrite (a move's `moved`, a delete's `deleted`, a restore's `restored`). */
export type IdMap = Record<string, string>;

interface HistoryEntryBase<T extends string> {
  type: T;
  /** Client-generated id. */
  id: string;
  /** ISO time the action was performed. */
  at: string;
}

export interface MoveItem {
  currentId: NodeId;
  oldParentId: NodeId;
  oldName: string;
}

export interface MoveHistoryEntry extends HistoryEntryBase<'move'> {
  items: MoveItem[];
}

export interface DeleteItem {
  trashId: TrashId;
  originalId: NodeId;
}

export interface DeleteHistoryEntry extends HistoryEntryBase<'delete'> {
  items: DeleteItem[];
}

/** Open union: a new action type = new member + codec + step kind. */
export type HistoryEntry = MoveHistoryEntry | DeleteHistoryEntry;

export const HISTORY_CAP = 50;
const VERSION = 1;

export const historyKey = (treeId: string) => `otago:undo:v${VERSION}:${treeId}`;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

function itemsOf<T>(raw: Record<string, unknown>, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
  const items: T[] = [];
  for (const item of raw.items) {
    const parsed = parse(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

const ENTRY_CODECS: {
  [T in HistoryEntry['type']]: (
    raw: Record<string, unknown> & { id: string; at: string },
  ) => Extract<HistoryEntry, { type: T }> | null;
} = {
  move: (raw) => {
    const items = itemsOf(raw, (item): MoveItem | null =>
      isRecord(item) &&
      isString(item.currentId) &&
      item.currentId !== '' &&
      isString(item.oldParentId) &&
      isString(item.oldName) &&
      item.oldName !== ''
        ? { currentId: item.currentId, oldParentId: item.oldParentId, oldName: item.oldName }
        : null,
    );
    return items && { type: 'move', id: raw.id, at: raw.at, items };
  },
  delete: (raw) => {
    const items = itemsOf(raw, (item): DeleteItem | null =>
      isRecord(item) &&
      isString(item.trashId) &&
      item.trashId !== '' &&
      isString(item.originalId) &&
      item.originalId !== ''
        ? { trashId: item.trashId, originalId: item.originalId }
        : null,
    );
    return items && { type: 'delete', id: raw.id, at: raw.at, items };
  },
};

function decodeEntry(raw: unknown): HistoryEntry | null {
  if (!isRecord(raw) || !isString(raw.type) || !isString(raw.id) || !isString(raw.at)) return null;
  if (!Object.hasOwn(ENTRY_CODECS, raw.type)) return null;
  const codec = ENTRY_CODECS[raw.type as HistoryEntry['type']];
  return codec(raw as Record<string, unknown> & { id: string; at: string });
}

const capped = (entries: HistoryEntry[]) =>
  entries.length > HISTORY_CAP ? entries.slice(-HISTORY_CAP) : entries;

/** Stack of `treeId`, oldest first. Anything unreadable is dropped silently. */
export function loadHistory(store: KeyValueStore, treeId: string): HistoryEntry[] {
  const text = store.get(historyKey(treeId));
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.v !== VERSION || !Array.isArray(parsed.entries)) return [];
  const entries = parsed.entries.map(decodeEntry).filter((e): e is HistoryEntry => e !== null);
  return capped(entries);
}

/** Write the stack of `treeId`; an empty stack removes the key. */
export function saveHistory(store: KeyValueStore, treeId: string, entries: HistoryEntry[]): void {
  store.set(
    historyKey(treeId),
    entries.length === 0 ? null : JSON.stringify({ v: VERSION, entries }),
  );
}

/** Carry a stack over to a renamed tree (TrashIds are tree-relative, so entries stay valid). */
export function renameHistoryKey(store: KeyValueStore, from: string, to: string): void {
  if (from === to) return;
  const value = store.get(historyKey(from));
  if (value === null) return;
  store.set(historyKey(to), value);
  store.set(historyKey(from), null);
}

// ---------------------------------------------------------------------------
// Remapping (contract rule)
// ---------------------------------------------------------------------------

/** `x === old` or `x` inside `old` → `new + rest`. Identity pairs and `''` keys are ignored. */
export function remapId(id: string, map: IdMap): string {
  for (const [from, to] of Object.entries(map)) {
    if (from === '' || from === to) continue;
    if (id === from || id.startsWith(`${from}/`)) return to + id.slice(from.length);
  }
  return id;
}

/** Same object when nothing changed. */
export function remapEntry(entry: HistoryEntry, map: IdMap): HistoryEntry {
  switch (entry.type) {
    case 'move': {
      let changed = false;
      const items = entry.items.map((item) => {
        const currentId = remapId(item.currentId, map);
        const oldParentId = remapId(item.oldParentId, map);
        if (currentId === item.currentId && oldParentId === item.oldParentId) return item;
        changed = true;
        return { ...item, currentId, oldParentId };
      });
      return changed ? { ...entry, items } : entry;
    }
    case 'delete': {
      let changed = false;
      const items = entry.items.map((item) => {
        const trashId = remapId(item.trashId, map);
        const originalId = remapId(item.originalId, map);
        if (trashId === item.trashId && originalId === item.originalId) return item;
        changed = true;
        return { trashId, originalId };
      });
      return changed ? { ...entry, items } : entry;
    }
    default:
      return assertNever(entry);
  }
}

/** Same array when nothing changed. */
export function remapHistory(entries: HistoryEntry[], map: IdMap): HistoryEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    const remapped = remapEntry(entry, map);
    if (remapped !== entry) changed = true;
    return remapped;
  });
  return changed ? next : entries;
}

function assertNever(value: never): never {
  throw new Error(`Unknown history entry: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Recording forward actions
// ---------------------------------------------------------------------------

/** Record a forward move (`moved` = response of the move). All-identity → nothing recorded. */
export function recordMove(
  entries: HistoryEntry[],
  moved: IdMap,
  now: string,
  newId: string,
): HistoryEntry[] {
  const items = Object.entries(moved)
    .filter(([from, to]) => from !== to && from !== '')
    .map(([from, to]) => ({ currentId: to, oldParentId: parentIdOf(from), oldName: nameOf(from) }));
  if (items.length === 0) return entries;
  const older = remapHistory(entries, moved);
  return capped([...older, { type: 'move', id: newId, at: now, items }]);
}

/** Record a forward delete (`deleted` = original id → TrashId). Empty → nothing recorded. */
export function recordDelete(
  entries: HistoryEntry[],
  deleted: Record<NodeId, TrashId>,
  now: string,
  newId: string,
): HistoryEntry[] {
  const items = Object.entries(deleted)
    .filter(([originalId, trashId]) => originalId !== '' && trashId !== '')
    .map(([originalId, trashId]) => ({ trashId, originalId }));
  if (items.length === 0) return entries;
  const older = remapHistory(entries, deleted);
  return capped([...older, { type: 'delete', id: newId, at: now, items }]);
}

// ---------------------------------------------------------------------------
// Undo steps
// ---------------------------------------------------------------------------

/** One request of an undo. `items` = indexes of the entry items the step covers. */
export type UndoStep =
  | {
      kind: 'move';
      items: number[];
      ids: NodeId[];
      targetParentId: NodeId;
      names: Record<NodeId, string>;
    }
  | { kind: 'restore'; items: number[]; trashIds: TrashId[] };

/** Next request for `entry`: a move groups by old parent (first group first); a delete is one restore. */
export function nextStep(entry: HistoryEntry): UndoStep | null {
  switch (entry.type) {
    case 'move': {
      const first = entry.items[0];
      if (!first) return null;
      const items: number[] = [];
      const ids: NodeId[] = [];
      const names: Record<NodeId, string> = {};
      entry.items.forEach((item, index) => {
        if (item.oldParentId !== first.oldParentId) return;
        items.push(index);
        ids.push(item.currentId);
        names[item.currentId] = item.oldName;
      });
      return { kind: 'move', items, ids, targetParentId: first.oldParentId, names };
    }
    case 'delete':
      if (entry.items.length === 0) return null;
      return {
        kind: 'restore',
        items: entry.items.map((_, index) => index),
        trashIds: entry.items.map((item) => item.trashId),
      };
    default:
      return assertNever(entry);
  }
}

/** `entry` without the items `step` covered; `null` when none are left. */
export function completeStep(entry: HistoryEntry, step: UndoStep): HistoryEntry | null {
  const done = new Set(step.items);
  switch (entry.type) {
    case 'move': {
      const items = entry.items.filter((_, index) => !done.has(index));
      return items.length === 0 ? null : { ...entry, items };
    }
    case 'delete': {
      const items = entry.items.filter((_, index) => !done.has(index));
      return items.length === 0 ? null : { ...entry, items };
    }
    default:
      return assertNever(entry);
  }
}

export type StepResponse = MoveResult | RestoreResult;

/** The id rewrite a successful step caused. */
export function idMapOf(step: UndoStep, response: StepResponse): IdMap {
  return step.kind === 'move'
    ? (response as MoveResult).moved
    : (response as RestoreResult).restored;
}

/** Original id → restored id for nodes that came back under another name (`-2`). */
export function restoredAsMoves(entry: DeleteHistoryEntry, restored: IdMap): IdMap {
  const fixups: IdMap = {};
  for (const { trashId, originalId } of entry.items) {
    const id = restored[trashId];
    if (id !== undefined && id !== originalId) fixups[originalId] = id;
  }
  return fixups;
}

const nonIdentity = (map: IdMap): IdMap =>
  Object.fromEntries(Object.entries(map).filter(([from, to]) => from !== to));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface UndoErrorVerdict {
  /** Drop the entry (stale / invalid) or keep it for a retry. */
  drop: boolean;
  message: string;
}

/** Policy: 400 → drop, 404 → drop, 409 → keep; network errors and 5xx → keep. */
export function classifyUndoError(error: unknown): UndoErrorVerdict {
  if (error instanceof ApiError) {
    if (error.status === 409) return { drop: false, message: describeError(error).message };
    if (error.status === 404) {
      const message =
        error.code === 'parent_not_found'
          ? i18n.t('graph:undo.parentMissing')
          : error.code === 'trash_not_found'
            ? i18n.t('graph:undo.trashMissing')
            : error.code === 'node_not_found'
              ? i18n.t('graph:undo.nodeMissing')
              : error.code === 'tree_not_found'
                ? i18n.t('graph:undo.treeMissing')
                : i18n.t('graph:undo.stale');
      return { drop: true, message };
    }
    if (error.status === 400) return { drop: true, message: i18n.t('graph:undo.invalid') };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { drop: false, message: i18n.t('graph:undo.failed', { message }) };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface UndoApi {
  move(ids: NodeId[], targetParentId: NodeId, names: Record<NodeId, string>): Promise<MoveResult>;
  restore(trashIds: TrashId[]): Promise<RestoreResult>;
}

export interface AppliedStep {
  /** Fresh hierarchy after the step. */
  nodes: HierarchyNode[];
  /**
   * Non-identity id rewrites of the step in move-map shape. `move`: the node ids moved back
   * (current node and side chat follow). `restore`: original id → restored id when a node came
   * back under another name (only the side chat follows; the current node is never inside trash).
   */
  fixups: IdMap;
  kind: UndoStep['kind'];
  /** Stack after the step (persist it right away). */
  entries: HistoryEntry[];
}

export interface UndoOutcome {
  entries: HistoryEntry[];
  /** `cause` = the original error (e.g. a 409 whose details name the blocking answers). */
  error?: { message: string; dropped: boolean; cause: unknown };
}

/** Undo the top entry. Steps run sequentially; `onStep` fires after each successful request. */
export async function runUndo(
  entries: HistoryEntry[],
  api: UndoApi,
  onStep?: (applied: AppliedStep) => void,
): Promise<UndoOutcome> {
  let list = entries;
  for (;;) {
    const entry = list.at(-1);
    if (!entry) return { entries: list };
    const step = nextStep(entry);
    if (!step) return { entries: list.slice(0, -1) };
    let response: StepResponse;
    try {
      response =
        step.kind === 'move'
          ? await api.move(step.ids, step.targetParentId, step.names)
          : await api.restore(step.trashIds);
    } catch (error) {
      const verdict = classifyUndoError(error);
      return {
        entries: verdict.drop ? list.slice(0, -1) : list,
        error: { message: verdict.message, dropped: verdict.drop, cause: error },
      };
    }
    const map = idMapOf(step, response);
    const fixups = entry.type === 'delete' ? restoredAsMoves(entry, map) : nonIdentity(map);
    list = remapHistory(list, map);
    const top = list.at(-1);
    const rest = top ? completeStep(top, step) : null;
    list = rest ? [...list.slice(0, -1), rest] : list.slice(0, -1);
    onStep?.({ nodes: response.nodes, fixups, kind: step.kind, entries: list });
    if (!rest) return { entries: list };
  }
}
