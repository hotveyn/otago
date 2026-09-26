import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { RouteDeps } from '../app.js';
import { NotFoundError } from '../errors.js';
import { isErrno } from '../storage/fs-utils.js';
import {
  assertNodeExists,
  assertUserFileName,
  existingTreeDir,
  userFileContentTypeOf,
  userFilePath,
} from '../storage/index.js';
import { fileQuery, fileResponseHeaders } from './file-headers.js';
import { treeParams } from './schemas.js';

/** Serves one user file (or an e-book's `.md` companion) of a committed node. */
export const userFileRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir }) => {
  // Read-only: not blocked by the tree lock.
  app.get(
    '/trees/:tree/files',
    { schema: { params: treeParams, querystring: fileQuery } },
    async (request, reply) => {
      const { node, name, download } = request.query;
      const dir = await existingTreeDir(treesDir, request.params.tree);
      assertUserFileName(name);
      await assertNodeExists(dir, node);
      const file = userFilePath(dir, node, name);
      const info = await stat(file).catch((error: unknown) => {
        if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
        throw error;
      });
      if (!info?.isFile()) throw new NotFoundError(`File not found: ${name}`);
      reply.headers(
        fileResponseHeaders(name, info.size, userFileContentTypeOf(name), Boolean(download)),
      );
      return reply.send(createReadStream(file));
    },
  );
};
