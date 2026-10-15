import { z } from 'zod';
import { nodeId } from './schemas.js';

/** Query of the file-serving routes (`/attachments`, `/files`). */
export const fileQuery = z.object({
  node: nodeId.min(1),
  name: z.string().min(1).max(200),
  download: z.literal('1').optional(),
});

/** Opening a file directly must never run scripts or load external resources. */
export const FILE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/**
 * Content types served WITHOUT `FILE_CSP`. Chromium refuses to run its built-in PDF viewer in a
 * document sandboxed by CSP ("blocked plugin"), and a citation click opens
 * `/files?…#page=N` in a new tab synchronously (pop-up blockers), so a blob workaround is not
 * possible. A PDF cannot script the page origin; the sandbox is for HTML/SVG/… files, which
 * keep it. `nosniff` stays for every type.
 */
export const CSP_EXEMPT_CONTENT_TYPES: readonly string[] = ['application/pdf'];

/** Response headers for serving one stored file (attachment or user file). */
export function fileResponseHeaders(
  name: string,
  size: number,
  contentType: string,
  download: boolean,
): Record<string, string> {
  const disposition = download ? 'attachment' : 'inline';
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(size),
    'content-disposition': `${disposition}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  };
  if (!CSP_EXEMPT_CONTENT_TYPES.includes(contentType)) {
    headers['content-security-policy'] = FILE_CSP;
  }
  return headers;
}
