import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app.js';
import {
  createTree,
  existingTreeDir,
  listTrees,
  readChain,
  readHierarchy,
  readTree,
  updateTree,
} from '../storage/index.js';
import { nodeId, treeInput, treeParams, treePatch } from './schemas.js';

export const treeRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir }) => {
  app.get('/trees', async () => ({ trees: await listTrees(treesDir) }));

  app.post('/trees', { schema: { body: treeInput } }, async (request, reply) => {
    const tree = await createTree(treesDir, request.body);
    return reply.code(201).send(tree);
  });

  app.get('/trees/:tree', { schema: { params: treeParams } }, async (request) => {
    const tree = await readTree(treesDir, request.params.tree);
    const dir = await existingTreeDir(treesDir, tree.id);
    return { ...tree, nodes: await readHierarchy(dir) };
  });

  app.patch('/trees/:tree', { schema: { params: treeParams, body: treePatch } }, async (request) =>
    updateTree(treesDir, request.params.tree, request.body),
  );

  app.get(
    '/trees/:tree/chain',
    { schema: { params: treeParams, querystring: z.object({ node: nodeId.default('') }) } },
    async (request) => {
      const dir = await existingTreeDir(treesDir, request.params.tree);
      return { chain: await readChain(dir, request.query.node) };
    },
  );
};
