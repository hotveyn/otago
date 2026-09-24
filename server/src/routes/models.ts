import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { RouteDeps } from '../app.js';

export const modelRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { models }) => {
  app.get('/models', async () => ({
    models: models.available,
    defaults: { answer: models.answer, naming: models.naming },
  }));
};
