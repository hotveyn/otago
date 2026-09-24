import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  ATTACHMENT_LINK_PREFIX,
  type AttachmentInfo,
  type AttachmentStaging,
} from '../storage/index.js';

export const ATTACHMENT_MCP_SERVER = 'otago';
export const SAVE_ATTACHMENT_TOOL = 'save_attachment';
/** Name to put in SDK `allowedTools`. */
export const SAVE_ATTACHMENT_TOOL_ID = `mcp__${ATTACHMENT_MCP_SERVER}__${SAVE_ATTACHMENT_TOOL}`;

export interface SaveAttachmentInput {
  name?: string;
  content?: string;
  encoding?: 'utf8' | 'base64';
  url?: string;
}

/** Success result, serialized as JSON in the tool's single text content block. */
export interface SaveAttachmentResult {
  name: string;
  path: string;
  size: number;
  contentType: string;
  kind: AttachmentInfo['kind'];
}

export interface SaveAttachmentToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export const saveAttachmentShape = {
  name: z
    .string()
    .max(500)
    .optional()
    .describe('File name with extension, e.g. "memory-layout.svg". Required with `content`.'),
  content: z.string().optional().describe('File content. Use with `encoding`.'),
  encoding: z
    .enum(['utf8', 'base64'])
    .optional()
    .describe('Encoding of `content`: "utf8" (default) for text/SVG/CSV, "base64" for binary.'),
  url: z.string().optional().describe('http(s) URL the server downloads instead of `content`.'),
};

export const SAVE_ATTACHMENT_DESCRIPTION = `Save a file (SVG illustration, CSV/TSV dataset, image, PDF, document, code) as an attachment of the answer you are writing.
Pass exactly one of:
- \`content\` (+ \`encoding\`: "utf8" default or "base64") together with \`name\`;
- \`url\` (http/https) to download a file; \`name\` is optional.
Returns JSON with the final \`name\` and \`path\` ("attachments/<name>"). The name may get a "-2" suffix, so always reference the returned \`path\`:
![alt](attachments/<name>) for images and SVG, [label](attachments/<name>) for other files.
The file is kept only if the answer completes.`;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function textResult(text: string, isError = false): SaveAttachmentToolResult {
  return isError
    ? { isError: true, content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }] };
}

/** Strict base64 → bytes. Throws with an agent-facing message. */
export function decodeBase64(content: string): Uint8Array {
  const compact = content.replace(/\s+/g, '');
  if (!BASE64_RE.test(compact) || compact.length % 4 !== 0) {
    throw new Error('Invalid base64 content');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.byteLength === 0) throw new Error('Empty content');
  return bytes;
}

/** Tool handler bound to one answer's staging. Never throws: errors become `isError` results. */
export function createSaveAttachmentHandler(staging: AttachmentStaging) {
  return async (args: SaveAttachmentInput): Promise<SaveAttachmentToolResult> => {
    try {
      const hasContent = args.content !== undefined;
      const hasUrl = args.url !== undefined;
      if (hasContent === hasUrl) {
        return textResult('Pass exactly one of `content` or `url`', true);
      }
      let info: AttachmentInfo;
      if (args.content !== undefined) {
        if (!args.name?.trim()) return textResult('`name` is required with `content`', true);
        const data =
          args.encoding === 'base64'
            ? decodeBase64(args.content)
            : new Uint8Array(Buffer.from(args.content, 'utf8'));
        info = await staging.saveFromBytes({ name: args.name, data, origin: 'inline' });
      } else {
        const name = args.name?.trim() || undefined;
        info = await staging.saveFromUrl({ url: args.url ?? '', name });
      }
      const result: SaveAttachmentResult = {
        name: info.name,
        path: `${ATTACHMENT_LINK_PREFIX}${info.name}`,
        size: info.size,
        contentType: info.contentType,
        kind: info.kind,
      };
      return textResult(JSON.stringify(result));
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  };
}

/** In-process MCP server `otago` with the `save_attachment` tool. */
export function createAttachmentMcpServer(staging: AttachmentStaging) {
  return createSdkMcpServer({
    name: ATTACHMENT_MCP_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        SAVE_ATTACHMENT_TOOL,
        SAVE_ATTACHMENT_DESCRIPTION,
        saveAttachmentShape,
        createSaveAttachmentHandler(staging),
        { alwaysLoad: true },
      ),
    ],
  });
}
