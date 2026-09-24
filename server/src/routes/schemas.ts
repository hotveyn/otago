import { z } from 'zod';

export const treeParams = z.object({ tree: z.string() });

export const nodeId = z.string().max(1000);

export const treeInput = z.object({
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(20_000).optional(),
});

export const treePatch = treeInput.partial().refine((patch) => Object.keys(patch).length > 0, {
  message: 'Nothing to update',
});
