/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 *
 * Existing shapes this feature builds on, copied for reference from earlier contracts
 * (`rich-answers`, `chat-file-attachments`, `tree-undo`, `rename-trees-nodes`).
 * UNCHANGED by this feature unless a comment says otherwise.
 */

/**
 * Node id = path of the node folder relative to the tree folder, `/`-joined; `""` = tree root.
 * CHANGED: segments may now contain Unicode letters (see ./node-names.ts). Always NFC on the
 * wire in responses. Max 1000 UTF-16 code units.
 */
export type NodeId = string;

/**
 * Tree id = tree folder name. UNCHANGED: ASCII kebab-case `[a-z0-9]+(-[a-z0-9]+)*`.
 * Tree ids travel in path params (`/api/trees/:tree/...`).
 */
export type TreeId = string;

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

/** Progress of one agent attachment save. Per `key`: `saving` → (`ready` | `failed`). Unchanged. */
export type AttachmentEvent =
  | { status: 'saving'; key: string; requestedName?: string; origin: AttachmentOrigin }
  | { status: 'ready'; key: string; attachment: AttachmentInfo }
  | { status: 'failed'; key: string; requestedName?: string; message: string };

/** One user file (`<node>/files/<name>`), as in `ChainNode.files`. Unchanged shape. */
export interface UserFileInfo {
  /** Stored (sanitized, server-chosen) file name. Matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`. */
  name: string;
  size: number;
  contentType: string;
  kind: AttachmentKind;
  /** E-books only: the extracted-text companion `<name>.md` in the same folder. */
  text?: string;
}

/** `ChainNode` of `GET /api/trees/:tree/chain?node=` (unchanged). */
export interface ChainNode {
  id: NodeId;
  name: string;
  created: string;
  model: string;
  user: string;
  assistant: string;
  attachments: AttachmentInfo[];
  files: UserFileInfo[];
}
