/**
 * Mirrors .claude/features/rich-answers/contracts (server owns the shape).
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
  user: string;
  assistant: string;
  /** Files in `<node>/attachments/`, sorted by name. `origin` is never set here. */
  attachments: AttachmentInfo[];
}

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

/** `done` SSE event payload. Attachment URLs are fetchable only after it arrives. */
export interface MessageDone {
  nodeId: string;
  attachments: AttachmentInfo[];
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
