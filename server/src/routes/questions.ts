// Routes of .claude/features/parallel-questions/contracts/questions-api.ts and
// question-events.ts.
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app.js';
import { AppError, UploadError } from '../errors.js';
import {
  parentNotFound,
  type QuestionContext,
  type QuestionInfo,
  questionNotFound,
} from '../questions/index.js';
import {
  type AnswerStaging,
  createAnswerStaging,
  createUserFileStager,
  existingTreeDir,
  nodeDirOf,
  readChain,
  readTree,
  sweepStaleStaging,
  type UserFileStager,
} from '../storage/index.js';
import {
  drainParts,
  openMessageInput,
  pickModel,
  receiveUserFiles,
  validateContext,
} from './message-input.js';
import { treeParams } from './schemas.js';
import { openSse } from './sse.js';

const questionParams = z.object({ id: z.uuid() });
const treeFilter = z.object({ tree: z.string().optional() });

/** The client went away while its upload was received; nothing was registered. */
class RequestAborted extends AppError {
  constructor() {
    super(400, 'Request aborted by the client');
  }
}

export const questionRoutes: FastifyPluginAsyncZod<RouteDeps> = async (
  app,
  { treesDir, models, locks, allowPrivateUrls, questions },
) => {
  // No body schema: the body is JSON or multipart and is validated by `openMessageInput`.
  app.post('/trees/:tree/questions', { schema: { params: treeParams } }, async (request, reply) => {
    const { tree: treeId } = request.params;
    const controller = new AbortController();
    const raw = reply.raw;
    // Until the question is registered, a client disconnect aborts: the upload stops and
    // nothing is registered or written. Afterwards the client connection is irrelevant.
    const onClose = () => {
      if (!raw.writableEnded) controller.abort('cancel');
    };
    raw.on('close', onClose);
    let question: QuestionInfo;
    try {
      question = await registerQuestion(treeId, request, controller);
    } finally {
      raw.off('close', onClose);
    }
    return reply.code(202).header('location', `/api/questions/${question.id}`).send({ question });
  });

  /**
   * Steps 1-6 of the contract: validate (body → models → context → tree), take the shared lock
   * with the new question id as holder, read the parent chain, stage the files, register.
   * Every error before the registration leaves nothing behind.
   */
  async function registerQuestion(
    treeId: string,
    request: FastifyRequest,
    controller: AbortController,
  ): Promise<QuestionInfo> {
    // Drains a rejected multipart request itself.
    const input = await openMessageInput(request);
    const multipart = input.kind === 'multipart' ? input : undefined;
    const drain = async () => {
      if (multipart) await drainParts(multipart);
    };
    const { parentId, text } = input.body;
    const context: QuestionContext = input.body.context ?? { kind: 'main' };

    let model: string;
    let namingModel: string;
    let treeDir: string;
    let id: string;
    let release: () => void;
    try {
      model = pickModel(input.body.model, models.answer, models.available);
      namingModel = pickModel(input.body.namingModel, models.naming, models.available);
      validateContext(parentId, context);
      treeDir = await existingTreeDir(treesDir, treeId);
      id = randomUUID();
      // Shared lock before reading, so a move/delete cannot change the chain; other questions
      // may run in parallel. Held through the upload, the answer and the commit.
      release = locks.acquireShared(treeId, id);
    } catch (error) {
      await drain();
      throw error;
    }

    const holder: { staging?: AnswerStaging } = {};
    const prepare = async () => {
      const tree = await readTree(treesDir, treeId);
      const chain = await readChain(treeDir, parentId).catch(parentNotFound(parentId));
      // The staging folder becomes the node folder on success (same parent → atomic rename).
      const parentDir = nodeDirOf(treeDir, parentId);
      await sweepStaleStaging(parentDir);
      const staging = await createAnswerStaging({
        parentDir,
        signal: controller.signal,
        allowPrivateUrls,
        onEvent: (event) => questions.registry.attachment(id, 1, event),
      });
      holder.staging = staging;
      let stager: UserFileStager | undefined;
      if (multipart) {
        // User files go to `<staging>/files/` and are fully validated before registration.
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

    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare();
      // The client left during the upload: tear down like any other rejection.
      if (controller.signal.aborted) throw new RequestAborted();
    } catch (error) {
      await holder.staging?.discard().catch((cause: unknown) => request.log.error(cause));
      release();
      await drain();
      throw controller.signal.aborted ? new RequestAborted() : error;
    }

    // Registration and the `question` event happen in this tick, before the 202.
    const { tree, chain, staging, stager } = prepared;
    return questions.start({
      id,
      tree: treeId,
      treeDir,
      parentId,
      context,
      text,
      model,
      namingModel,
      instructions: tree.instructions,
      chain,
      staging,
      files: stager?.list() ?? [],
      promptFiles: stager?.promptFiles(treeDir) ?? [],
      controller,
      release,
    });
  }

  app.get('/questions', { schema: { querystring: treeFilter } }, async (request) => ({
    instance: questions.instance,
    questions: questions.list(request.query.tree),
  }));

  app.get('/questions/events', { schema: { querystring: treeFilter } }, async (request, reply) => {
    const { retryMs, pingIntervalMs, maxBufferedBytes } = questions.timings;
    const sse = openSse(reply, { retryMs, pingIntervalMs, maxBufferedBytes });
    // Snapshot and subscription in one tick; the snapshot is written before any later event.
    const { snapshot, unsubscribe } = questions.subscribe({
      tree: request.query.tree,
      onEvent: (event) => sse.send(event.seq, event.event, event.data),
      onEnd: () => sse.end(),
    });
    sse.send(snapshot.seq, 'snapshot', {
      instance: snapshot.instance,
      questions: snapshot.questions,
    });
    // Closing a stream never touches the questions.
    sse.onClose(unsubscribe);
  });

  app.get('/questions/:id', { schema: { params: questionParams } }, async (request) => {
    const question = questions.detail(request.params.id);
    if (!question) throw questionNotFound(request.params.id);
    return { question };
  });

  // DELETE and retry take no body; any body is ignored (even an empty JSON one, which the
  // default parser would reject with 400).
  await app.register(async (scope) => {
    const bodiless = scope.withTypeProvider<ZodTypeProvider>();
    bodiless.removeAllContentTypeParsers();
    bodiless.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, _body, done) =>
      done(null, undefined),
    );

    bodiless.delete(
      '/questions/:id',
      { schema: { params: questionParams } },
      async (request, reply) => {
        await questions.remove(request.params.id);
        return reply.code(204).send();
      },
    );

    bodiless.post(
      '/questions/:id/retry',
      { schema: { params: questionParams } },
      async (request, reply) => {
        const question = await questions.retry(request.params.id);
        return reply
          .code(202)
          .header('location', `/api/questions/${question.id}`)
          .send({ question });
      },
    );
  });
};
