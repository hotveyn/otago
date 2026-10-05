/**
 * Questions that block a structural op (409 `tree_busy_streaming`). PURE.
 * Mirrors `TreeBusyDetails` of .claude/features/parallel-questions/contracts/errors.ts.
 */
import { ApiError } from '../api/client';
import type {
  BlockingQuestion,
  QuestionContext,
  RunningQuestionStatus,
  TreeBusyDetails,
} from '../api/types';
import { isRunning, type QuestionsState } from './questions';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

function contextOf(value: unknown): QuestionContext | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'main') return { kind: 'main' };
  if (value.kind === 'side' && isString(value.anchor))
    return { kind: 'side', anchor: value.anchor };
  return null;
}

function blockingQuestionOf(value: unknown): BlockingQuestion | null {
  if (!isRecord(value)) return null;
  const { id, tree, parentId, title, status } = value;
  const context = contextOf(value.context);
  if (!isString(id) || !isString(tree) || !isString(parentId) || !isString(title) || !context)
    return null;
  if (status !== 'streaming' && status !== 'naming') return null;
  return { id, tree, parentId, context, title, status };
}

/** `details` of a 409 `tree_busy_streaming`; malformed items are dropped. */
export function treeBusyDetailsOf(error: unknown): TreeBusyDetails | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (error.code !== 'tree_busy_streaming' || !isRecord(error.details)) return null;
  const raw = error.details;
  const questions = Array.isArray(raw.questions)
    ? raw.questions.map(blockingQuestionOf).filter((item) => item !== null)
    : [];
  const preparing =
    typeof raw.preparing === 'number' && Number.isFinite(raw.preparing) && raw.preparing > 0
      ? Math.floor(raw.preparing)
      : 0;
  return { questions, preparing };
}

/** Node a DELETE found already created (409 `question_finished`). */
export function finishedNodeIdOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (error.code !== 'question_finished' || !isRecord(error.details)) return null;
  return isString(error.details.nodeId) ? error.details.nodeId : null;
}

export interface BlockerItem {
  id: string;
  title: string;
  parentId: string;
  context: QuestionContext;
  status: RunningQuestionStatus;
  /** A DELETE of this tab is in flight. */
  cancelling: boolean;
  /** `server`: only known from the 409 (the store has not seen it). */
  source: 'store' | 'server';
}

export interface BlockerList {
  items: BlockerItem[];
  /** Server-side lock holders without a question (informational). */
  preparing: number;
  /** Sends of this tab still uploading to the tree. */
  uploading: number;
}

export interface BlockersOpened {
  details: TreeBusyDetails | null;
  /** `snapshotCount` of the store when the dialog opened. */
  snapshotCount: number;
}

/**
 * Live list for the blockers dialog: the store's running questions of `tree`, plus questions
 * only the 409 named. Those are dropped once the store knows better (removed, known and not
 * running, or a newer snapshot arrived since the dialog opened).
 */
export function blockerList(
  state: QuestionsState,
  tree: string,
  opened: BlockersOpened,
): BlockerList {
  const items: BlockerItem[] = Object.values(state.questions)
    .filter((info) => info.tree === tree && isRunning(info))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((info) => ({
      id: info.id,
      title: info.title,
      parentId: info.parentId,
      context: info.context,
      status: info.status === 'naming' ? 'naming' : 'streaming',
      cancelling: Boolean(state.cancelling[info.id]),
      source: 'store',
    }));
  const stale = state.snapshotCount > opened.snapshotCount;
  for (const question of opened.details?.questions ?? []) {
    if (stale || question.tree !== tree) continue;
    if (Object.hasOwn(state.questions, question.id)) continue;
    if (state.tombstones.includes(question.id)) continue;
    items.push({
      id: question.id,
      title: question.title,
      parentId: question.parentId,
      context: question.context,
      status: question.status,
      cancelling: Boolean(state.cancelling[question.id]),
      source: 'server',
    });
  }
  const uploading = Object.values(state.outbox).filter(
    (entry) => entry.tree === tree && entry.error === null,
  ).length;
  return { items, preparing: opened.details?.preparing ?? 0, uploading };
}

const itemEqual = (a: BlockerItem, b: BlockerItem) =>
  a.id === b.id &&
  a.title === b.title &&
  a.parentId === b.parentId &&
  a.status === b.status &&
  a.cancelling === b.cancelling &&
  a.source === b.source;

export function blockerListEqual(a: BlockerList, b: BlockerList): boolean {
  return (
    a.preparing === b.preparing &&
    a.uploading === b.uploading &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => itemEqual(item, b.items[index] as BlockerItem))
  );
}
