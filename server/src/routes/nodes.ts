import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app.js';
import { deleteNodes, existingTreeDir, moveNodes, readHierarchy } from '../storage/index.js';
import { nodeId, treeParams } from './schemas.js';

const ids = z.array(nodeId).min(1).max(1000);

export const nodeRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir, locks }) => {
  app.post(
    '/trees/:tree/nodes/delete',
    { schema: { params: treeParams, body: z.object({ ids }) } },
    async (request) => {
      const { tree } = request.params;
      const dir = await existingTreeDir(treesDir, tree);
      return locks.withLock(tree, async () => {
        await deleteNodes(dir, request.body.ids);
        return { nodes: await readHierarchy(dir) };
      });
    },
  );

  app.post(
    '/trees/:tree/nodes/move',
    { schema: { params: treeParams, body: z.object({ ids, targetParentId: nodeId }) } },
    async (request) => {
      const { tree } = request.params;
      const dir = await existingTreeDir(treesDir, tree);
      return locks.withLock(tree, async () => {
        const moved = await moveNodes(dir, request.body.ids, request.body.targetParentId);
        return { moved, nodes: await readHierarchy(dir) };
      });
    },
  );
};
