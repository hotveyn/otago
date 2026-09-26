/**
 * CONTRACT SPEC (planning artifact) — feature `rich-answers`.
 * POST /api/trees/:tree/messages — `text/event-stream` events.
 * Request body is unchanged: { parentId, text, model?, namingModel? }.
 * Wire format unchanged: `event: <name>\ndata: <JSON>\n\n`.
 */
import type { AttachmentInfo, AttachmentOrigin } from './attachments';

/**
 * Lifecycle of one `save_attachment` call (or, later, one sandbox-emitted file).
 * Events for the same file share `key`. Order per key: `saving` → (`ready` | `failed`).
 * `failed` means the tool returned an error to the agent; the answer continues.
 */
export type AttachmentEvent =
  | {
      status: 'saving';
      /** Opaque, unique within the stream. */
      key: string;
      /** Name as requested by the agent (unsanitized; may be absent for URL downloads). */
      requestedName?: string;
      origin: AttachmentOrigin;
    }
  | {
      status: 'ready';
      key: string;
      /** Final record; `origin` is set. The file is staged, NOT yet fetchable over HTTP. */
      attachment: AttachmentInfo;
    }
  | {
      status: 'failed';
      key: string;
      requestedName?: string;
      /** Human-readable reason (same text the agent received). */
      message: string;
    };

/** Event name → JSON payload. */
export interface MessageStreamEvents {
  /** Text delta (unchanged). */
  chunk: string;
  /** NEW. Attachment progress; may interleave with `chunk` at any point before `done`. */
  attachment: AttachmentEvent;
  /**
   * Final event on success (CHANGED — additive `attachments`).
   * `attachments` = all files committed into `<nodeId>/attachments/`, sorted by name,
   * identical to what `GET /chain` will return for this node (no `origin`).
   * Only after `done` are attachment URLs fetchable.
   */
  done: { nodeId: string; attachments: AttachmentInfo[] };
  /** Final event on failure (unchanged). No node and no attachments were written. */
  error: { message: string };
}

export type MessageStreamEventName = keyof MessageStreamEvents;
