// Route of .claude/features/inline-suggestions/contracts/suggestions-api.ts (GET only; the
// lazy POST is gone). Pure read: takes no tree lock, never 409, never blocks structural routes.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { RouteDeps } from '../app.js';
import { viewSuggestions } from '../storage/index.js';
import { suggestionsQuery, treeParams } from './schemas.js';

export const suggestionRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { treesDir }) => {
  // Resolved list (own, or the nearest stored ancestor's); always `ready`.
  app.get(
    '/trees/:tree/suggestions',
    { schema: { params: treeParams, querystring: suggestionsQuery } },
    async (request) => viewSuggestions(treesDir, request.params.tree, request.query.node),
  );
};
