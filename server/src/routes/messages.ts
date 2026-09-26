import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { type AgentEvent, fallbackNodeName } from '../agent/index.js';
import type { RouteDeps } from '../app.js';
import { InvalidInputError, UploadError } from '../errors.js';
import {
  type AnswerStaging,
  createAnswerStaging,
  createNode,
  createUserFileStager,
  existingTreeDir,
  listAttachments,
  listUserFiles,
  nodeDirOf,
  readChain,
  readTree,
  sweepStaleStaging,
  type UserFileStager,
} from '../storage/index.js';
import {
  drainParts,
  EMPTY_TEXT_QUESTION,
  openMessageInput,
  receiveUserFiles,
} from './message-input.js';
import { treeParams } from './schemas.js';

export const messageRoutes: FastifyPluginAsyncZod<RouteDeps> = async (
  app,
  { treesDir, agent, models, locks, allowPrivateUrls },
) => {
  // No body schema: the body is JSON or multipart and is validated by `openMessageInput`.
  app.post('/trees/:tree/messages', { schema: { params: treeParams } }, async (request, reply) => {
    const { tree: treeId } = request.params;
    // Drains a rejected multipart request itself.
    const input = await openMessageInput(request);
    const multipart = input.kind === 'multipart' ? input : undefined;
    const drain = async () => {
      if (multipart) await drainParts(multipart);
    };
    const { parentId, text } = input.body;

    let model: string;
    let namingModel: string;
    let treeDir: string;
    let release: () => void;
    try {
      model = pickModel(input.body.model, models.answer, models.available);
      namingModel = pickModel(input.body.namingModel, models.naming, models.available);
      treeDir = await existingTreeDir(treesDir, treeId);
      // Shared lock before reading, so a move/delete cannot change the chain; other streams
      // may run in parallel. Held through the upload until the node is created and the
      // stream ends.
      release = locks.acquireShared(treeId);
    } catch (error) {
      await drain();
      throw error;
    }

    const controller = new AbortController();
    const raw = reply.raw;
    // Attached before the upload, so a disconnect while files arrive stops the writes too.
    const onClose = () => {
      if (!raw.writableEnded) controller.abort();
    };
    raw.on('close', onClose);
    let send: (event: string, data: unknown) => void = () => {};

    const prepare = async (holder: { staging?: AnswerStaging }) => {
      const tree = await readTree(treesDir, treeId);
      const chain = await readChain(treeDir, parentId);
      // The staging folder becomes the node folder on success (same parent → atomic rename).
      const parentDir = nodeDirOf(treeDir, parentId);
      await sweepStaleStaging(parentDir);
      const staging = await createAnswerStaging({
        parentDir,
        signal: controller.signal,
        allowPrivateUrls,
        onEvent: (event) => send('attachment', event),
      });
      holder.staging = staging;
      let stager: UserFileStager | undefined;
      if (multipart) {
        // User files go to `<staging>/files/` and are fully validated before any SSE byte.
        stager = createUserFileStager({ stagingDir: staging.dir, signal: controller.signal });
        await receiveUserFiles(multipart, stager);
      }
      if (!text && (stager?.list().length ?? 0) === 0) {
        throw new UploadError(
          'Message is empty: type a question or attach a file',
          'empty_message',
        );
      }
      return { tree, chain, staging, stager };
    };

    const holder: { staging?: AnswerStaging } = {};
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(holder);
    } catch (error) {
      raw.off('close', onClose);
      await holder.staging?.discard().catch((cause: unknown) => request.log.error(cause));
      release();
      await drain();
      throw error;
    }
    const { tree, chain, staging, stager } = prepared;
    const fileNames = stager?.list().map((file) => file.name) ?? [];
    const question = text || EMPTY_TEXT_QUESTION;
    const namingQuestion = text || `Attached files: ${fileNames.join(', ')}`;

    reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    send = (event: string, data: unknown) => {
      if (!raw.destroyed && !raw.writableEnded) {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    const namePromise = agent
      .name({ question: namingQuestion, model: namingModel, signal: controller.signal })
      .catch(() => fallbackNodeName(namingQuestion));

    let committed = false;
    try {
      let answer: Extract<AgentEvent, { type: 'done' }> | undefined;
      const events = agent.ask({
        treeDir,
        instructions: tree.instructions,
        chain,
        question,
        files: stager?.promptFiles(treeDir) ?? [],
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

      // Drops only an empty `attachments/`; `files/` is left alone.
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
      const nodeDir = nodeDirOf(treeDir, newId);
      send('done', {
        nodeId: newId,
        attachments: await listAttachments(nodeDir),
        files: await listUserFiles(nodeDir),
      });
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
      // Renamed into the node or discarded by now: sweeps may consider the path again.
      staging.release();
      release();
      raw.end();
    }
  });
};

function pickModel(requested: string | undefined, fallback: string, available: string[]): string {
  if (requested === undefined) return fallback;
  if (!available.includes(requested)) {
    throw new InvalidInputError(`Unknown model "${requested}". Available: ${available.join(', ')}`);
  }
  return requested;
}
