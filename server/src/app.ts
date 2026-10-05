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
import { AppError, TreeBusyError } from './errors.js';
import { Questions } from './questions/index.js';
import { attachmentRoutes } from './routes/attachments.js';
import { healthRoutes } from './routes/health.js';
import { modelRoutes } from './routes/models.js';
import { nodeRoutes } from './routes/nodes.js';
import { questionRoutes } from './routes/questions.js';
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
  /**
   * In-flight questions. Default: a new service on `locks` with an owned holding folder.
   * Closed with the app either way.
   */
  questions?: Questions;
}

export interface RouteDeps {
  treesDir: string;
  agent: Agent;
  models: ModelConfig;
  locks: TreeLocks;
  allowPrivateUrls: boolean;
  questions: Questions;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const locks = deps.locks ?? new TreeLocks();
  const allowPrivateUrls = deps.allowPrivateUrls ?? false;
  const questions =
    deps.questions ??
    new Questions({
      agent: deps.agent,
      locks,
      treesDir: deps.treesDir,
      allowPrivateUrls,
      log: app.log,
    });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: 'Invalid input', details: error.validation });
    }
    if (error instanceof AppError) {
      // Every exclusive route names the questions that block it (contract `errors.ts`).
      const details =
        error instanceof TreeBusyError && error.code === 'tree_busy_streaming'
          ? questions.blockers(error.treeId, error.holders)
          : error.details;
      return reply.code(error.statusCode).send({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(details !== undefined ? { details } : {}),
      });
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) return reply.code(statusCode).send({ error: error.message });
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  // Hijacked SSE replies would keep `server.close()` waiting: end them first. Then stop the
  // running answers (their staging is discarded, nothing is written).
  app.addHook('preClose', async () => {
    questions.endStreams();
  });
  app.addHook('onClose', async () => {
    await questions.close();
  });

  await app.register(multipart, { limits: { fileSize: MAX_SOURCE_BYTES, files: 1 } });

  const routeDeps: RouteDeps = {
    treesDir: deps.treesDir,
    agent: deps.agent,
    models: deps.models ?? DEFAULT_MODELS,
    locks,
    allowPrivateUrls,
    questions,
  };
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(modelRoutes, routeDeps);
      await api.register(treeRoutes, routeDeps);
      await api.register(sourceRoutes, routeDeps);
      await api.register(questionRoutes, routeDeps);
      await api.register(nodeRoutes, routeDeps);
      await api.register(attachmentRoutes, routeDeps);
      await api.register(userFileRoutes, routeDeps);
    },
    { prefix: '/api' },
  );
  return app;
}
