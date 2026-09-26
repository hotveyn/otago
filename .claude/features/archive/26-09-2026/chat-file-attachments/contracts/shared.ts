/**
 * CONTRACT SPEC (planning artifact) — feature `chat-file-attachments`.
 * Existing shapes this feature builds on, copied from the `rich-answers` / `side-chat` contracts
 * for reference. UNCHANGED by this feature.
 */

/** Node ids are `/`-joined kebab-case folder names; `""` is the tree root. Max 1000 chars. */
export type NodeId = string;

export type AttachmentKind = 'image' | 'svg' | 'table' | 'text' | 'pdf' | 'other';
export type AttachmentOrigin = 'inline' | 'url' | 'sandbox';

/** Agent-generated file in `<node>/attachments/` (unchanged). */
export interface AttachmentInfo {
  name: string;
  size: number;
  contentType: string;
  kind: AttachmentKind;
  /** Present only in streaming events. */
  origin?: AttachmentOrigin;
}

/** `event: attachment` payload (unchanged). */
export type AttachmentEvent =
  | { status: 'saving'; key: string; requestedName?: string; origin: AttachmentOrigin }
  | { status: 'ready'; key: string; attachment: AttachmentInfo }
  | { status: 'failed'; key: string; requestedName?: string; message: string };

export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';
