import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AgentEvent, fallbackNodeName } from '../agent/index.js';
import type { RouteDeps } from '../app.js';
import { InvalidInputError } from '../errors.js';
import {
  type AnswerStaging,
  createAnswerStaging,
  createNode,
  existingTreeDir,
  listAttachments,
  nodeDirOf,
  readChain,
  readTree,
  sweepStaleStaging,
} from '../storage/index.js';
import { nodeId, treeParams } from './schemas.js';

const messageBody = z.object({
  parentId: nodeId,
  text: z.string().trim().min(1).max(50_000),
  /** Answer model; defaults to `OTAGO_MODEL`. */
  model: z.string().optional(),
  /** Node naming model; defaults to `OTAGO_NAMING_MODEL`. */
  namingModel: z.string().optional(),
});

export const messageRoutes: FastifyPluginAsyncZod<RouteDeps> = async (
  app,
  { treesDir, agent, models, locks, allowPrivateUrls },
) => {
  app.post(
    '/trees/:tree/messages',
    { schema: { params: treeParams, body: messageBody } },
    async (request, reply) => {
      const { tree: treeId } = request.params;
      const { parentId, text } = request.body;
      const model = pickModel(request.body.model, models.answer, models.available);
      const namingModel = pickModel(request.body.namingModel, models.naming, models.available);
      const treeDir = await existingTreeDir(treesDir, treeId);

      // Lock before reading so a concurrent move/delete cannot change the chain.
      const release = locks.acquire(treeId);
      const controller = new AbortController();
      let send: (event: string, data: unknown) => void = () => {};
      let tree: Awaited<ReturnType<typeof readTree>>;
      let chain: Awaited<ReturnType<typeof readChain>>;
      let staging: AnswerStaging;
      try {
        tree = await readTree(treesDir, treeId);
        chain = await readChain(treeDir, parentId);
        // The staging folder becomes the node folder on success (same parent → atomic rename).
        const parentDir = nodeDirOf(treeDir, parentId);
        await sweepStaleStaging(parentDir);
        staging = await createAnswerStaging({
          parentDir,
          signal: controller.signal,
          allowPrivateUrls,
          onEvent: (event) => send('attachment', event),
        });
      } catch (error) {
        release();
        throw error;
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const onClose = () => {
        if (!raw.writableEnded) controller.abort();
      };
      raw.on('close', onClose);
      send = (event: string, data: unknown) => {
        if (!raw.destroyed && !raw.writableEnded) {
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const namePromise = agent
        .name({ question: text, model: namingModel, signal: controller.signal })
        .catch(() => fallbackNodeName(text));

      let committed = false;
      try {
        let answer: Extract<AgentEvent, { type: 'done' }> | undefined;
        const events = agent.ask({
          treeDir,
          instructions: tree.instructions,
          chain,
          question: text,
          model,
          signal: controller.signal,
          staging,
        });
        for await (const event of events) {
          if (controller.signal.aborted) break;
          if (event.type === 'chunk') send('chunk', event.text);
          else answer = event;
        }
        if (controller.signal.aborted) return;
        if (!answer) throw new Error('Agent finished without an answer');

        await staging.seal();
        const name = await namePromise;
        if (controller.signal.aborted) return;
        const newId = await createNode(
          treeDir,
          parentId,
          name,
          {
            created: new Date().toISOString(),
            model: answer.model,
            user: text,
            assistant: answer.text,
          },
          { stagingDir: staging.dir },
        );
        committed = true;
        const attachments = await listAttachments(nodeDirOf(treeDir, newId));
        send('done', { nodeId: newId, attachments });
      } catch (error) {
        if (!controller.signal.aborted) {
          request.log.error(error);
          send('error', { message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        raw.off('close', onClose);
        controller.abort();
        if (!committed) {
          await staging.discard().catch((error: unknown) => request.log.error(error));
        }
        release();
        raw.end();
      }
    },
  );
};

function pickModel(requested: string | undefined, fallback: string, available: string[]): string {
  if (requested === undefined) return fallback;
  if (!available.includes(requested)) {
    throw new InvalidInputError(`Unknown model "${requested}". Available: ${available.join(', ')}`);
  }
  return requested;
}
