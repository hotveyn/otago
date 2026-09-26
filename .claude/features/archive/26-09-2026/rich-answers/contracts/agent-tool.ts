/**
 * CONTRACT SPEC (planning artifact) — feature `rich-answers`.
 * The server-implemented agent tool. Server-internal (the web never calls it), recorded here
 * so the whole data shape lives in one place.
 * Implemented as an in-process SDK MCP tool: server name `otago`, tool `save_attachment`.
 */
import type { AttachmentKind } from './attachments';

export const ATTACHMENT_MCP_SERVER = 'otago';
export const SAVE_ATTACHMENT_TOOL = 'save_attachment';
/** Name to put in SDK `allowedTools`. */
export const SAVE_ATTACHMENT_TOOL_ID = 'mcp__otago__save_attachment';

/**
 * Input. Exactly one of `content` / `url`.
 * - `content` + `encoding` ('utf8' default | 'base64'); `name` required.
 * - `url` (http/https only); `name` optional — fallback: Content-Disposition filename, then the
 *   last URL path segment, then `attachment`; a missing extension is derived from Content-Type.
 * Errors → tool result with `isError: true` (answer continues):
 *   both/neither of content/url, empty content, invalid base64, bad URL scheme, blocked private
 *   address, HTTP status >= 400, too many redirects (> 5), timeout, write failure.
 */
export interface SaveAttachmentInput {
  name?: string;
  content?: string;
  encoding?: 'utf8' | 'base64';
  url?: string;
}

/** Success result, serialized as JSON in the tool's single text content block. */
export interface SaveAttachmentResult {
  /** Final sanitized name (may carry a `-2` suffix). The agent must reference this one. */
  name: string;
  /** Markdown reference path to use in the answer, `attachments/<name>`. */
  path: string;
  size: number;
  contentType: string;
  kind: AttachmentKind;
}

/** Server-side download policy for `url` inputs. */
export const URL_DOWNLOAD_POLICY = {
  protocols: ['http:', 'https:'],
  maxRedirects: 5,
  /** Until response headers arrive. */
  headersTimeoutMs: 30_000,
  /** Max gap between body chunks (no total cap: size is unlimited, streamed to disk). */
  idleTimeoutMs: 60_000,
  /** Open question 1: proposed default blocks loopback/private/link-local; env override. */
  blockPrivateAddresses: true,
  allowPrivateEnv: 'OTAGO_ALLOW_PRIVATE_URLS',
} as const;
