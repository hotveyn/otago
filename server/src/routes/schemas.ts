import { z } from 'zod';

export const treeParams = z.object({ tree: z.string() });

/** Node id; normalized to NFC before validation (an NFD id resolves to the same node). */
export const nodeId = z.string().normalize('NFC').max(1000);

/** Trash id (`<parent id>/<name>.deleted-<ts>[-n]`), normalized to NFC. */
export const trashId = z.string().normalize('NFC').max(1000);

/** Requested node folder name (move `names` values), normalized to NFC. */
export const desiredNodeName = z.string().normalize('NFC').max(200);

/** `context` of a question (pure data echoed back to clients). */
export const questionContext = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('side'), anchor: nodeId }),
]);

export const treeInput = z.object({
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(20_000).optional(),
});

export const treePatch = treeInput.partial().refine((patch) => Object.keys(patch).length > 0, {
  message: 'Nothing to update',
});
