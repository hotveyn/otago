/**
 * The mock backend: VFS + storage + locks + questions, exposed as an object with the shape of
 * `api` from `web/src/api/client.ts`. Each method plays the route of the same name in
 * `server/src/routes/` (404 before the lock, lock, storage call, question remaps).
 */
import type { api as realApi } from '../../../web/src/api/client';
import type { FileFolder, ModelsInfo } from '../../../web/src/api/types';
import { BlobUrls } from './blob-urls';
import { badRequest, payloadTooLarge } from './errors';
import { DEMO_MAX_FILE_BYTES } from './files';
import { TreeLocks } from './locks';
import { Questions, type Schedule } from './questions';
import { TreeStore } from './trees';
import { Vfs, type VfsStorage } from './vfs';

export type DemoApi = typeof realApi;

/** As the server defaults (`server/src/config.ts`). */
export const DEMO_MODELS: ModelsInfo = {
  models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5'],
  defaults: { answer: 'claude-opus-5-5', naming: 'claude-haiku-4-5' },
};

export interface DemoOptions {
  storage: VfsStorage;
  /** Initial files (VFS path → text), written when the storage holds no state. */
  seed: Record<string, string>;
  now?: () => number;
  random?: () => number;
  schedule?: Schedule;
  uuid?: () => string;
  /** Simulated network latency of every call, ms. Default 40–120. */
  latency?: () => number;
}

export interface Demo {
  vfs: Vfs;
  trees: TreeStore;
  questions: Questions;
  api: DemoApi;
  urls: {
    source(treeId: string, file: string): string;
    nodeFile(folder: FileFolder, treeId: string, nodeId: string, name: string): string;
  };
}

const nfc = (id: string) => id.normalize('NFC');
const decoder = new TextDecoder();

function checkTitle(title: unknown): void {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
    throw badRequest('Invalid input');
  }
}

async function readUpload(file: File): Promise<Uint8Array> {
  if (file.size > DEMO_MAX_FILE_BYTES) {
    throw payloadTooLarge(
      `"${file.name}" is too large: the demo stores files in the browser and accepts up to ${DEMO_MAX_FILE_BYTES / 1024} KB per file`,
    );
  }
  return new Uint8Array(await file.arrayBuffer());
}

export function createDemo(options: DemoOptions): Demo {
  const vfs = new Vfs(options.storage);
  if (!vfs.load()) vfs.reset(options.seed);
  const trees = new TreeStore(vfs);
  const questions = new Questions({
    trees,
    models: DEMO_MODELS,
    now: options.now,
    random: options.random,
    schedule: options.schedule,
    uuid: options.uuid,
  });
  const locks = new TreeLocks((treeId, holders) => questions.blockers(treeId, holders));
  questions.attachLocks(locks);
  const blobs = new BlobUrls(vfs);

  const latency = options.latency ?? (() => 40 + Math.random() * 80);
  /** Answer after a short "network" delay; the work itself is synchronous, so atomic. */
  const respond = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const ms = latency();
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    return fn();
  };

  const api: DemoApi = {
    listTrees: () => respond(() => trees.listTrees()),
    createTree: (input) =>
      respond(() => {
        checkTitle(input.title);
        return trees.createTree(input);
      }),
    getTree: (id) => respond(() => ({ ...trees.readTree(id), nodes: trees.hierarchy(id) })),
    updateTree: (id, patch) =>
      respond(() => {
        if (patch.title === undefined && patch.instructions === undefined) {
          throw badRequest('Invalid input', undefined, [{ message: 'Nothing to update' }]);
        }
        if (patch.title === undefined) return trees.updateTree(id, patch);
        checkTitle(patch.title);
        trees.assertTree(id);
        const newId = trees.treeIdForTitle(id, patch.title);
        return locks.withExclusive(newId === id ? [id] : [id, newId], () => {
          const result = trees.updateTree(id, patch);
          questions.renameTree(id, result.id);
          return result;
        });
      }),
    getChain: (id, node) => respond(() => trees.chain(id, nfc(node))),
    getAttachmentText: (id, node, name, folder = 'attachments') =>
      respond(() => decoder.decode(trees.readNodeFileContent(id, nfc(node), folder, name).bytes)),
    getAttachmentBlob: (id, node, name, folder = 'attachments') =>
      respond(() => {
        const { bytes, contentType } = trees.readNodeFileContent(id, nfc(node), folder, name);
        return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType });
      }),

    listSources: (id) => respond(() => trees.listSources(id)),
    getSourceText: (id, file) => respond(() => decoder.decode(trees.readSource(id, file).bytes)),
    uploadSource: (id, file) =>
      respond(async () => {
        trees.assertTree(id);
        return trees.saveSource(id, file.name, await readUpload(file));
      }),
    deleteSource: (id, file) => respond(() => trees.deleteSource(id, file)),

    deleteNodes: (id, ids) =>
      respond(() => {
        trees.assertTree(id);
        return locks.withExclusive([id], () => {
          const deleted = trees.deleteNodes(id, ids.map(nfc));
          questions.dropUnder(id, Object.keys(deleted));
          return { deleted, nodes: trees.hierarchy(id) };
        });
      }),
    moveNodes: (id, ids, targetParentId, names) =>
      respond(() => {
        trees.assertTree(id);
        return locks.withExclusive([id], () => {
          const normalized = names
            ? Object.fromEntries(Object.entries(names).map(([k, v]) => [nfc(k), nfc(v)]))
            : undefined;
          const moved = trees.moveNodes(id, ids.map(nfc), nfc(targetParentId), normalized);
          questions.remap(id, moved);
          return { moved, nodes: trees.hierarchy(id) };
        });
      }),
    restoreNodes: (id, trashIds) =>
      respond(() => {
        trees.assertTree(id);
        return locks.withExclusive([id], () => ({
          restored: trees.restoreNodes(id, trashIds.map(nfc)),
          nodes: trees.hierarchy(id),
        }));
      }),
    renameNode: (id, nodeId, name) =>
      respond(() => {
        trees.assertTree(id);
        return locks.withExclusive([id], () => {
          const result = trees.renameNode(id, nfc(nodeId), nfc(name));
          if (result.id !== nodeId) questions.remap(id, result.renamed);
          return { ...result, nodes: trees.hierarchy(id) };
        });
      }),

    getModels: () => respond(() => DEMO_MODELS),

    startQuestion: (treeId, input, signal) =>
      respond(() =>
        questions.start(
          treeId,
          {
            parentId: nfc(input.parentId),
            text: input.text,
            model: input.model,
            namingModel: input.namingModel,
            context: input.context,
            files: input.files,
          },
          signal,
        ),
      ),
    cancelQuestion: (id) => respond(() => questions.cancel(id)),
    retryQuestion: (id) => respond(() => questions.retry(id)),
  };

  return {
    vfs,
    trees,
    questions,
    api,
    urls: {
      source: (treeId, file) =>
        blobs.url(trees.sourcePath(treeId, file), trees.sourceContentType(file)),
      nodeFile: (folder, treeId, nodeId, name) =>
        blobs.url(
          trees.nodeFilePath(treeId, nfc(nodeId), folder, name),
          trees.fileContentType(name),
        ),
    },
  };
}
