import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app.js';
import { NotFoundError } from '../errors.js';
import { isErrno } from '../storage/fs-utils.js';
import {
  assertAttachmentName,
  assertNodeExists,
  attachmentContentTypeOf,
  attachmentPath,
  existingTreeDir,
} from '../storage/index.js';
import { nodeId, treeParams } from './schemas.js';

/** Opening a file directly must never run scripts or load external resources. */
export const ATTACHMENT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

const attachmentQuery = z.object({
  node: nodeId.min(1),
  name: z.string().min(1).max(200),
  download: z.literal('1').optional(),
});

export const attachmentRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir }) => {
  // Read-only: not blocked by the tree lock.
  app.get(
    '/trees/:tree/attachments',
    { schema: { params: treeParams, querystring: attachmentQuery } },
    async (request, reply) => {
      const { node, name, download } = request.query;
      const dir = await existingTreeDir(treesDir, request.params.tree);
      assertAttachmentName(name);
      await assertNodeExists(dir, node);
      const file = attachmentPath(dir, node, name);
      const info = await stat(file).catch((error: unknown) => {
        if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
        throw error;
      });
      if (!info?.isFile()) throw new NotFoundError(`Attachment not found: ${name}`);

      const disposition = download ? 'attachment' : 'inline';
      reply.headers({
        'content-type': attachmentContentTypeOf(name),
        'content-length': String(info.size),
        'content-disposition': `${disposition}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': ATTACHMENT_CSP,
        'cache-control': 'no-cache',
      });
      return reply.send(createReadStream(file));
    },
  );
};
