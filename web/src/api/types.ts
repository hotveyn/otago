/**
 * Mirrors .claude/features/rich-answers/contracts and
 * .claude/features/chat-file-attachments/contracts and
 * .claude/features/rename-trees-nodes/contracts (server owns the shape).
 * Hand-maintained: there is no codegen in this repo.
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

/** `done` SSE event payload. Attachment and file URLs are fetchable only after it arrives. */
export interface MessageDone {
  nodeId: string;
  attachments: AttachmentInfo[];
  /** The new node's user files, exactly as `GET /chain` returns them (`[]` when none). */
  files: UserFileInfo[];
}

/**
 * `payload` field of a multipart `POST /messages`. `text` may be empty when files are attached.
 * Mirrors .claude/features/chat-file-attachments/contracts/messages.ts.
 */
export interface MessagePayload {
  parentId: string;
  text?: string;
  model?: string;
  namingModel?: string;
  // urls?: string[] — reserved by the contract
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

/** JSON body of every non-2xx `/api/*` response. */
export interface ErrorBody {
  /** Human-readable, safe to show. Upload errors name the original file name. */
  error: string;
  /** 409 lock conflicts, 404 reasons and message-upload rejections. */
  code?: ConflictCode | MessageUploadErrorCode | NotFoundCode;
  /** Present only on 400 schema validation errors. */
  details?: unknown;
}
