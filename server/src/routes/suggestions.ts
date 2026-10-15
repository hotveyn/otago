// Routes of .claude/features/suggested-prompts/contracts/suggestions-api.ts. No tree lock: never
// 409, never blocks structural routes.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { RouteDeps } from '../app.js';
import { suggestionsBody, suggestionsQuery, treeParams } from './schemas.js';

export const suggestionRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { suggestions }) => {
  // Pure read: resolved list (`ready`) or `missing`; never generates.
  app.get(
    '/trees/:tree/suggestions',
    { schema: { params: treeParams, querystring: suggestionsQuery } },
    async (request) => suggestions.view(request.params.tree, request.query.node),
  );

  // Lazy generation, deduped per node. Not cancelled by a client disconnect: the result is
  // stored either way, so the next open finds it.
  app.post(
    '/trees/:tree/suggestions',
    { schema: { params: treeParams, body: suggestionsBody } },
    async (request) => suggestions.ensure(request.params.tree, request.body.node),
  );
};
