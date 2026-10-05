/**
 * Mirrors .claude/features/rich-answers/contracts and
 * .claude/features/chat-file-attachments/contracts and
 * .claude/features/rename-trees-nodes/contracts and
 * .claude/features/parallel-questions/contracts (server owns the shape).
 * Hand-maintained: there is no codegen in this repo.
 *
 * Node ids (`HierarchyNode.id`, `ChainNode.id`, `parentId`, …) are `/`-joined folder names.
 * Segments may contain Unicode letters, marks and digits; the server always sends them in NFC.
 */

export interface TreeMeta {
  id: string;
  title: string;
  created: string;
  instructions: string;
}

export interface HierarchyNode {
  id: string;
  name: string;
  created: string;
  children: HierarchyNode[];
}

export interface TreeDetail extends TreeMeta {
  nodes: HierarchyNode[];
}

export interface ChainNode {
  id: string;
  name: string;
  created: string;
  model: string;
  /** User text as stored in node.md; may be `""` for a files-only message. */
  user: string;
  assistant: string;
  /** Files in `<node>/attachments/`, sorted by name. `origin` is never set here. */
  attachments: AttachmentInfo[];
  /** Files the user attached to this message, in `<node>/files/`; `[]` for older nodes. */
  files: UserFileInfo[];
}

/** Which folder of a node a file lives in: agent `attachments/` or user `files/` (web-only). */
export type FileFolder = 'attachments' | 'files';

/** Preview category, computed by the server from the file extension. */
export type AttachmentKind = 'image' | 'svg' | 'table' | 'text' | 'pdf' | 'other';

/** Only known while streaming; absent on records read from disk. */
export type AttachmentOrigin = 'inline' | 'url' | 'sandbox';

export interface AttachmentInfo {
  /** Final file name inside `attachments/` (sanitized, unique within the node). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** MIME type the server serves the file with. */
  contentType: string;
  kind: AttachmentKind;
  /** Present only in streaming events. */
  origin?: AttachmentOrigin;
}

/** `attachment` SSE event. Events for one file share `key`: `saving` -> `ready` | `failed`. */
export type AttachmentEvent =
  | { status: 'saving'; key: string; requestedName?: string; origin: AttachmentOrigin }
  | { status: 'ready'; key: string; attachment: AttachmentInfo }
  | { status: 'failed'; key: string; requestedName?: string; message: string };

/**
 * One user file of a node, as returned in `ChainNode.files` and `done.files`.
 * Mirrors .claude/features/chat-file-attachments/contracts/user-files.ts.
 */
export interface UserFileInfo {
  /** Stored file name inside `<node>/files/` (sanitized, unique within the node). */
  name: string;
  /** Size in bytes of the original file. */
  size: number;
  /** MIME type the file is served with. */
  contentType: string;
  /** Preview category: images → `image`, `.md/.txt` → `text`, `.pdf` → `pdf`, e-books → `other`. */
  kind: AttachmentKind;
  /**
   * E-books only: name of the extracted-text companion in the same folder (`<name>.md`).
   * The companion is NOT listed as a separate entry; it is fetchable via the files route.
   */
  text?: string;
}

// ---------------------------------------------------------------------------
// In-flight questions. Mirrors .claude/features/parallel-questions/contracts/questions.ts,
// questions-api.ts, question-events.ts and errors.ts.
// ---------------------------------------------------------------------------

/** Server-generated UUID. Never changes, also across retries. */
export type QuestionId = string;

/** `streaming` → `naming` → `done`; any attempt may end `failed`. Cancelled = removed. */
export type QuestionStatus = 'streaming' | 'naming' | 'done' | 'failed';

/** Holds the tree's shared lock and blocks structural ops (409). */
export type RunningQuestionStatus = Extract<QuestionStatus, 'streaming' | 'naming'>;

/** Which chat the question belongs to (pure data echoed back by the server). */
export type QuestionContext = { kind: 'main' } | { kind: 'side'; anchor: string };

export type QuestionFailureCode = 'agent_error' | 'timeout' | 'internal';

export interface QuestionError {
  /** Human-readable, safe to show. */
  message: string;
  code: QuestionFailureCode;
}

interface QuestionBase {
  id: QuestionId;
  /** Current tree id (rewritten after a tree rename). */
  tree: string;
  /** Current parent node id (remapped after moves/renames). */
  parentId: string;
  context: QuestionContext;
  /** User text as stored in `node.md` (`""` for a files-only message). */
  text: string;
  /** Server display title: first line, ≤ 80 graphemes + `…`; file names for files-only. */
  title: string;
  /** User files with their final stored names, sorted by name (`[]` when none). */
  files: UserFileInfo[];
  model: string;
  namingModel: string;
  /** 1-based; incremented by every retry. */
  attempt: number;
  createdAt: string;
  /** Last status/meta change (not bumped by chunks or attachment events). */
  updatedAt: string;
}

export interface RunningQuestion extends QuestionBase {
  status: RunningQuestionStatus;
}

export interface DoneQuestion extends QuestionBase {
  status: 'done';
  /** The created node. */
  nodeId: string;
  /** Committed agent attachments of the node (no `origin`). */
  attachments: AttachmentInfo[];
}

export interface FailedQuestion extends QuestionBase {
  status: 'failed';
  error: QuestionError;
}

/** Full meta of a question: every 202 and every `question` event carries the whole object. */
export type QuestionInfo = RunningQuestion | DoneQuestion | FailedQuestion;

/** Live state of the current attempt (`attempt === question.attempt`). */
export interface QuestionLive {
  attempt: number;
  /** Every chunk of this attempt so far (UTF-16 code units; chunk offsets continue here). */
  answer: string;
  /** Latest attachment event per `key`, in order of the key's first appearance. */
  attachments: AttachmentEvent[];
}

/** Question + live state (`snapshot` entries). `live` is `null` for `done`. */
export type QuestionDetail = QuestionInfo & { live: QuestionLive | null };

/**
 * `POST /trees/:tree/questions`: the JSON body (then `text` is required) or the multipart
 * `payload` field (then `text` may be empty when files are attached).
 */
export interface StartQuestionPayload {
  parentId: string;
  text?: string;
  model?: string;
  namingModel?: string;
  /** Default `{ kind: 'main' }`. */
  context?: QuestionContext;
}

/** 202 of `POST /trees/:tree/questions`. */
export interface StartQuestionResponse {
  question: QuestionInfo;
}

/** 202 of `POST /questions/:id/retry`. */
export interface RetryQuestionResponse {
  question: QuestionInfo;
}

/** `event: snapshot`: always first on every connection; authoritative. */
export interface SnapshotEventData {
  /** Random id per server process; a new value means every question was lost. */
  instance: string;
  questions: QuestionDetail[];
}

/** `event: question`: added, status change, retry or remap. */
export interface QuestionEventData {
  question: QuestionInfo;
}

/** `event: chunk`: `offset` = length of this attempt's answer before `text`. */
export interface ChunkEventData {
  id: QuestionId;
  tree: string;
  attempt: number;
  offset: number;
  text: string;
}

/** `event: attachment`: agent attachment progress of `attempt`. */
export interface AttachmentEventData {
  id: QuestionId;
  tree: string;
  attempt: number;
  event: AttachmentEvent;
}

export type QuestionRemovedReason = 'cancelled' | 'dismissed' | 'expired' | 'evicted' | 'deleted';

/** `event: removed`: the last event of a question id. */
export interface RemovedEventData {
  id: QuestionId;
  tree: string;
  reason: QuestionRemovedReason;
  /** Present when the removed entry was `done`. */
  nodeId?: string;
}

export type QuestionStreamEvent =
  | { event: 'snapshot'; data: SnapshotEventData }
  | { event: 'question'; data: QuestionEventData }
  | { event: 'chunk'; data: ChunkEventData }
  | { event: 'attachment'; data: AttachmentEventData }
  | { event: 'removed'; data: RemovedEventData };

/** One question that holds the tree's shared lock. */
export interface BlockingQuestion {
  id: QuestionId;
  tree: string;
  parentId: string;
  context: QuestionContext;
  title: string;
  status: RunningQuestionStatus;
}

/** `details` of every 409 `tree_busy_streaming`. */
export interface TreeBusyDetails {
  /** Running questions of the tree, sorted by `createdAt`. */
  questions: BlockingQuestion[];
  /** Shared-lock holders without a running question (uploads, retries being prepared). */
  preparing: number;
}

/** `details` of 409 `question_finished`. */
export interface QuestionFinishedDetails {
  nodeId: string;
}

export interface SourceInfo {
  name: string;
  size: number;
  /** E-books only: the source with the extracted Markdown text. */
  text?: string;
}

export interface ModelsInfo {
  models: string[];
  defaults: { answer: string; naming: string };
}

export interface MoveResult {
  moved: Record<string, string>;
  nodes: HierarchyNode[];
}

/**
 * `POST /nodes/rename` response. Mirrors .claude/features/rename-trees-nodes/contracts/rename-api.ts.
 */
export interface RenameNodeResult {
  /** Resulting id of the renamed node. */
  id: string;
  /** Resulting folder name (last segment of `id`, `-2`… included). */
  name: string;
  /** Old id → new id for the renamed node (first key) and every live descendant. */
  renamed: Record<string, string>;
  nodes: HierarchyNode[];
}

/**
 * `PATCH /trees/:tree` response: the tree after the update (`id` is new when a title change
 * renamed the folder). Mirrors .claude/features/rename-trees-nodes/contracts/rename-api.ts.
 */
export interface UpdateTreeResult extends TreeMeta {
  /** Tree id from the request and the title before the update. */
  previous: { id: string; title: string };
}

/**
 * Tree-relative path of a soft-deleted node folder (`<liveParent>/<name>.deleted-<ms>`).
 * Mirrors .claude/features/tree-undo/contracts/trash.ts.
 */
export type TrashId = string;

/** `POST /nodes/delete` response. Mirrors .claude/features/tree-undo/contracts/nodes-api.ts. */
export interface DeleteResult {
  /** Top-level deleted node id → TrashId of its soft-deleted folder. */
  deleted: Record<string, TrashId>;
  nodes: HierarchyNode[];
}

/** `POST /nodes/restore` response. Mirrors .claude/features/tree-undo/contracts/nodes-api.ts. */
export interface RestoreResult {
  /** TrashId → resulting live node id (original name, or `-2`… if it was taken). */
  restored: Record<TrashId, string>;
  nodes: HierarchyNode[];
}

/** 404 codes. Mirrors .claude/features/tree-undo/contracts/errors.ts. */
export type NotFoundCode =
  | 'node_not_found'
  | 'parent_not_found'
  | 'trash_not_found'
  | 'tree_not_found';

/** 409 tree-lock conflict codes. Mirrors .claude/features/side-chat/contracts/errors.ts. */
export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';

/**
 * Machine-readable reason of a message-upload rejection (always with a human `error`).
 * Mirrors .claude/features/chat-file-attachments/contracts/http.ts.
 */
export type MessageUploadErrorCode =
  | 'invalid_payload'
  | 'empty_message'
  | 'too_many_files'
  | 'unsupported_file_type'
  | 'empty_file'
  | 'unreadable_file'
  | 'file_too_large';

/** Codes of the question routes. Mirrors .claude/features/parallel-questions/contracts/errors.ts. */
export type QuestionErrorCode =
  /** 404: unknown id, or already removed. */
  | 'question_not_found'
  /** 409 on DELETE: the question produced a node (`details: QuestionFinishedDetails`). */
  | 'question_finished'
  /** 409 on retry: the question is running, done, or already being retried. */
  | 'question_not_failed';

/** JSON body of every non-2xx `/api/*` response. */
export interface ErrorBody {
  /** Human-readable, safe to show. Upload errors name the original file name. */
  error: string;
  /** 409 lock conflicts, 404 reasons, message-upload rejections and question errors. */
  code?: ConflictCode | MessageUploadErrorCode | NotFoundCode | QuestionErrorCode;
  /**
   * 400 `Invalid input` (schema issues), 409 `tree_busy_streaming` (`TreeBusyDetails`),
   * 409 `question_finished` (`QuestionFinishedDetails`).
   */
  details?: unknown;
}
