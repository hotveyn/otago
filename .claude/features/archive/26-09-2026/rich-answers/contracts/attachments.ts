/**
 * CONTRACT SPEC (planning artifact) — feature `rich-answers`.
 * Owner: server. Consumers: web.
 * Interfaces / enums / constants only. Not a runtime module.
 *
 * Attachment model: plain files at `<tree>/<node-path>/attachments/<name>`.
 * No sidecar metadata file; everything below is derived from the file itself
 * (name, extension, size). `node.md` format is unchanged.
 */

/** Folder name inside every node folder. Reserved at every node level (never a node name). */
export const ATTACHMENTS_DIR = 'attachments';

/**
 * How the answer text references an attachment of the SAME node:
 * a relative Markdown link or image whose URL starts with this prefix, e.g.
 *   ![Memory layout](attachments/memory-layout.svg)
 *   [Benchmarks](attachments/benchmarks.csv)
 * The web resolves `attachments/<name>` against the node that owns the answer
 * (for a streaming answer: against the staged list from `attachment` events).
 * Names are URL-safe by construction (see ATTACHMENT_NAME_PATTERN), but the client
 * should still `decodeURIComponent` the part after the prefix.
 */
export const ATTACHMENT_LINK_PREFIX = 'attachments/';

/**
 * Final (sanitized) attachment names always match this pattern:
 * starts with an alphanumeric char, then `[A-Za-z0-9._-]`, max 120 chars, never contains `..`,
 * never starts with `.` (dotfiles in `attachments/` are ignored by the server).
 */
export const ATTACHMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * Preview category, computed by the server from the file extension so both sides agree.
 * - image: .png .jpg .jpeg .gif .webp .avif .bmp .ico
 * - svg:   .svg (shown inline via <img> / sanitized; never executed)
 * - table: .csv .tsv
 * - text:  .txt .md .json .yaml .yml .toml .xml .html .css .js .jsx .ts .tsx .py .rs .go .java
 *          .kt .c .h .cpp .hpp .cs .rb .php .sh .sql .ini .log .diff .patch (and other known code exts)
 * - pdf:   .pdf
 * - other: everything else (download only)
 */
export type AttachmentKind = 'image' | 'svg' | 'table' | 'text' | 'pdf' | 'other';

/**
 * Where an attachment came from. Only known while the answer is being generated
 * (reported in `attachment` SSE events). Not persisted, so absent on records read from disk.
 * `sandbox` is reserved for the future code-execution feature; the server does not emit it yet.
 */
export type AttachmentOrigin = 'inline' | 'url' | 'sandbox';

/** Source-agnostic attachment record. */
export interface AttachmentInfo {
  /** Final file name inside `attachments/` (sanitized, unique within the node). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** MIME type the server serves the file with, e.g. `image/svg+xml`, `text/csv; charset=utf-8`. */
  contentType: string;
  kind: AttachmentKind;
  /** Present only in streaming events; never on records from `GET /chain`. */
  origin?: AttachmentOrigin;
}

/**
 * Default client-side preview thresholds (feature Open question 2 — proposed defaults).
 * Above a threshold the UI shows only metadata + Download (and for tables: first N rows).
 * The server does not enforce these; it serves any size.
 */
export const PREVIEW_LIMITS = {
  /** Raster images and SVG. */
  imageBytes: 20 * 1024 * 1024,
  /** Text/code previews. */
  textBytes: 2 * 1024 * 1024,
  /** CSV/TSV files are fetched for table preview only below this size. */
  tableBytes: 10 * 1024 * 1024,
  /** Rows rendered/sorted/filtered; the rest behind "download full file". */
  tableRows: 5_000,
  /** PDF preview via <iframe>/<object>. */
  pdfBytes: 50 * 1024 * 1024,
} as const;
