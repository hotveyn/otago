import multipart from '@fastify/multipart';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Agent, TreeLocks } from './agent/index.js';
import { DEFAULT_MODELS, type ModelConfig } from './config.js';
import { AppError } from './errors.js';
import { attachmentRoutes } from './routes/attachments.js';
import { healthRoutes } from './routes/health.js';
import { messageRoutes } from './routes/messages.js';
import { modelRoutes } from './routes/models.js';
import { nodeRoutes } from './routes/nodes.js';
import { sourceRoutes } from './routes/sources.js';
import { treeRoutes } from './routes/trees.js';
import { userFileRoutes } from './routes/user-files.js';
import { MAX_SOURCE_BYTES } from './storage/index.js';

export { MAX_SOURCE_BYTES };

export interface AppDeps {
  treesDir: string;
  agent: Agent;
  models?: ModelConfig;
  locks?: TreeLocks;
  logger?: boolean;
  /** Let `save_attachment` download from loopback/private addresses. Default `false`. */
  allowPrivateUrls?: boolean;
}

export interface RouteDeps {
  treesDir: string;
  agent: Agent;
  models: ModelConfig;
  locks: TreeLocks;
  allowPrivateUrls: boolean;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: 'Invalid input', details: error.validation });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) return reply.code(statusCode).send({ error: error.message });
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  await app.register(multipart, { limits: { fileSize: MAX_SOURCE_BYTES, files: 1 } });

  const routeDeps: RouteDeps = {
    treesDir: deps.treesDir,
    agent: deps.agent,
    models: deps.models ?? DEFAULT_MODELS,
    locks: deps.locks ?? new TreeLocks(),
    allowPrivateUrls: deps.allowPrivateUrls ?? false,
  };
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(modelRoutes, routeDeps);
      await api.register(treeRoutes, routeDeps);
      await api.register(sourceRoutes, routeDeps);
      await api.register(messageRoutes, routeDeps);
      await api.register(nodeRoutes, routeDeps);
      await api.register(attachmentRoutes, routeDeps);
      await api.register(userFileRoutes, routeDeps);
    },
    { prefix: '/api' },
  );
  return app;
}
