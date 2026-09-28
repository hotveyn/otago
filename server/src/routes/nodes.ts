import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app.js';
import {
  deleteNodes,
  existingTreeDir,
  moveNodes,
  readHierarchy,
  renameNode,
  restoreNodes,
} from '../storage/index.js';
import { nodeId, treeParams } from './schemas.js';

const ids = z.array(nodeId).min(1).max(1000);

export const nodeRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir, locks }) => {
  app.post(
    '/trees/:tree/nodes/delete',
    { schema: { params: treeParams, body: z.object({ ids }) } },
    async (request) => {
      const { tree } = request.params;
      const dir = await existingTreeDir(treesDir, tree);
      return locks.withExclusive(tree, async () => {
        const deleted = await deleteNodes(dir, request.body.ids);
        return { deleted, nodes: await readHierarchy(dir) };
      });
    },
  );

  app.post(
    '/trees/:tree/nodes/move',
    {
      schema: {
        params: treeParams,
        body: z.object({
          ids,
          targetParentId: nodeId,
          names: z.record(nodeId, z.string().max(200)).optional(),
        }),
      },
    },
    async (request) => {
      const { tree } = request.params;
      const { ids, targetParentId, names } = request.body;
      const dir = await existingTreeDir(treesDir, tree);
      return locks.withExclusive(tree, async () => {
        const moved = await moveNodes(dir, ids, targetParentId, { names });
        return { moved, nodes: await readHierarchy(dir) };
      });
    },
  );

  app.post(
    '/trees/:tree/nodes/restore',
    {
      schema: {
        params: treeParams,
        body: z.object({ trashIds: z.array(z.string().max(1000)).min(1).max(1000) }),
      },
    },
    async (request) => {
      const { tree } = request.params;
      const dir = await existingTreeDir(treesDir, tree);
      return locks.withExclusive(tree, async () => {
        const restored = await restoreNodes(dir, request.body.trashIds);
        return { restored, nodes: await readHierarchy(dir) };
      });
    },
  );

  app.post(
    '/trees/:tree/nodes/rename',
    {
      schema: {
        params: treeParams,
        body: z.object({ id: nodeId, name: z.string().trim().min(1).max(200) }),
      },
    },
    async (request) => {
      const { tree } = request.params;
      const { id, name } = request.body;
      const dir = await existingTreeDir(treesDir, tree);
      return locks.withExclusive(tree, async () => {
        const result = await renameNode(dir, id, name);
        return { ...result, nodes: await readHierarchy(dir) };
      });
    },
  );
};
