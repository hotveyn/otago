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

/** Response headers for serving one stored file (attachment or user file). */
export function fileResponseHeaders(
  name: string,
  size: number,
  contentType: string,
  download: boolean,
): Record<string, string> {
  const disposition = download ? 'attachment' : 'inline';
  return {
    'content-type': contentType,
    'content-length': String(size),
    'content-disposition': `${disposition}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': FILE_CSP,
    'cache-control': 'no-cache',
  };
}
