import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
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
import { FILE_CSP, fileQuery, fileResponseHeaders } from './file-headers.js';
import { treeParams } from './schemas.js';

/** Opening a file directly must never run scripts or load external resources. */
export const ATTACHMENT_CSP = FILE_CSP;

export const attachmentRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir }) => {
  // Read-only: not blocked by the tree lock.
  app.get(
    '/trees/:tree/attachments',
    { schema: { params: treeParams, querystring: fileQuery } },
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

      reply.headers(
        fileResponseHeaders(name, info.size, attachmentContentTypeOf(name), Boolean(download)),
      );
      return reply.send(createReadStream(file));
    },
  );
};
