import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app.js';
import { InvalidInputError } from '../errors.js';
import {
  assertSourceName,
  contentTypeOf,
  deleteSource,
  existingTreeDir,
  listSources,
  readSource,
  saveSource,
} from '../storage/index.js';
import { treeParams } from './schemas.js';

const fileParams = treeParams.extend({ file: z.string() });

export const sourceRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir }) => {
  app.get('/trees/:tree/sources', { schema: { params: treeParams } }, async (request) => {
    const dir = await existingTreeDir(treesDir, request.params.tree);
    return { sources: await listSources(dir) };
  });

  app.post('/trees/:tree/sources', { schema: { params: treeParams } }, async (request, reply) => {
    const dir = await existingTreeDir(treesDir, request.params.tree);
    if (!request.isMultipart()) throw new InvalidInputError('Expected multipart/form-data');
    const file = await request.file();
    if (!file) throw new InvalidInputError('No file uploaded');
    assertSourceName(file.filename);
    const content = await file.toBuffer();
    return reply.code(201).send(await saveSource(dir, file.filename, content));
  });

  app.get(
    '/trees/:tree/sources/:file',
    { schema: { params: fileParams } },
    async (request, reply) => {
      const dir = await existingTreeDir(treesDir, request.params.tree);
      const content = await readSource(dir, request.params.file);
      return reply.type(contentTypeOf(request.params.file)).send(content);
    },
  );

  app.delete(
    '/trees/:tree/sources/:file',
    { schema: { params: fileParams } },
    async (request, reply) => {
      const dir = await existingTreeDir(treesDir, request.params.tree);
      await deleteSource(dir, request.params.file);
      return reply.code(204).send();
    },
  );
};
