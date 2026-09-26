import { i18n } from '../i18n';
import { MESSAGE_FILES_FIELD, MESSAGE_PAYLOAD_FIELD } from '../lib/chat-files';
import { readSse } from './sse';
import type {
  AttachmentEvent,
  AttachmentInfo,
  ChainNode,
  ConflictCode,
  ErrorBody,
  FileFolder,
  HierarchyNode,
  MessageDone,
  MessagePayload,
  MessageUploadErrorCode,
  ModelsInfo,
  MoveResult,
  SourceInfo,
  TreeDetail,
  TreeMeta,
  UserFileInfo,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set for 409 tree-lock conflicts and message-upload rejections from a server that sends it. */
    readonly code?: ConflictCode | MessageUploadErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CONFLICT_CODES: readonly string[] = [
  'tree_busy_streaming',
  'tree_busy_structural',
] satisfies ConflictCode[];

const UPLOAD_ERROR_CODES: readonly string[] = [
  'invalid_payload',
  'empty_message',
  'too_many_files',
  'unsupported_file_type',
  'empty_file',
  'unreadable_file',
  'file_too_large',
] satisfies MessageUploadErrorCode[];

const isErrorCode = (value: unknown): value is ConflictCode | MessageUploadErrorCode =>
  typeof value === 'string' &&
  (CONFLICT_CODES.includes(value) || UPLOAD_ERROR_CODES.includes(value));

async function errorOf(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  let code: ConflictCode | MessageUploadErrorCode | undefined;
  try {
    const body = (await res.json()) as Partial<ErrorBody>;
    if (body.error) message = body.error;
    if (isErrorCode(body.code)) code = body.code;
  } catch {
    // Not JSON; keep the status line.
  }
  return new ApiError(res.status, message, code);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) throw await errorOf(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

const tree = (id: string) => `/trees/${encodeURIComponent(id)}`;

export const sourceUrl = (treeId: string, file: string) =>
  `/api${tree(treeId)}/sources/${encodeURIComponent(file)}`;

/** Contract URL recipe for a file of a committed node (agent attachment or user file). */
export const nodeFileUrl = (
  folder: FileFolder,
  treeId: string,
  nodeId: string,
  name: string,
  download = false,
) =>
  `/api${tree(treeId)}/${folder}?node=${encodeURIComponent(nodeId)}&name=${encodeURIComponent(name)}${
    download ? '&download=1' : ''
  }`;

/** Contract URL recipe for a committed node's attachment. */
export const attachmentUrl = (treeId: string, nodeId: string, name: string, download = false) =>
  nodeFileUrl('attachments', treeId, nodeId, name, download);

/** Contract URL recipe for a file the user attached to a committed message. */
export const userFileUrl = (treeId: string, nodeId: string, name: string, download = false) =>
  nodeFileUrl('files', treeId, nodeId, name, download);

async function fetchNodeFile(
  folder: FileFolder,
  treeId: string,
  nodeId: string,
  name: string,
): Promise<Response> {
  const res = await fetch(nodeFileUrl(folder, treeId, nodeId, name));
  if (!res.ok) throw await errorOf(res);
  return res;
}

export const api = {
  listTrees: () => request<{ trees: TreeMeta[] }>('/trees').then((r) => r.trees),
  createTree: (input: { title: string; instructions?: string }) =>
    request<TreeMeta>('/trees', json('POST', input)),
  getTree: (id: string) => request<TreeDetail>(tree(id)),
  updateTree: (id: string, patch: { title?: string; instructions?: string }) =>
    request<TreeMeta>(tree(id), json('PATCH', patch)),
  getChain: (id: string, node: string) =>
    request<{ chain: ChainNode[] }>(`${tree(id)}/chain?node=${encodeURIComponent(node)}`).then(
      // Defensive: an older server omits the fields.
      (r) =>
        r.chain.map((item) => ({
          ...item,
          attachments: item.attachments ?? [],
          files: item.files ?? [],
        })),
    ),
  getAttachmentText: (id: string, node: string, name: string, folder: FileFolder = 'attachments') =>
    fetchNodeFile(folder, id, node, name).then((res) => res.text()),
  getAttachmentBlob: (id: string, node: string, name: string, folder: FileFolder = 'attachments') =>
    fetchNodeFile(folder, id, node, name).then((res) => res.blob()),

  listSources: (id: string) =>
    request<{ sources: SourceInfo[] }>(`${tree(id)}/sources`).then((r) => r.sources),
  getSourceText: async (id: string, file: string) => {
    const res = await fetch(sourceUrl(id, file));
    if (!res.ok) throw await errorOf(res);
    return res.text();
  },
  uploadSource: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<SourceInfo>(`${tree(id)}/sources`, { method: 'POST', body: form });
  },
  deleteSource: (id: string, file: string) =>
    request<void>(`${tree(id)}/sources/${encodeURIComponent(file)}`, { method: 'DELETE' }),

  deleteNodes: (id: string, ids: string[]) =>
    request<{ nodes: HierarchyNode[] }>(`${tree(id)}/nodes/delete`, json('POST', { ids })).then(
      (r) => r.nodes,
    ),
  moveNodes: (id: string, ids: string[], targetParentId: string) =>
    request<MoveResult>(`${tree(id)}/nodes/move`, json('POST', { ids, targetParentId })),

  getModels: () => request<ModelsInfo>('/models'),
};

export interface SendMessageInput {
  treeId: string;
  parentId: string;
  text: string;
  model?: string;
  namingModel?: string;
  signal: AbortSignal;
  onChunk: (text: string) => void;
  onAttachment?: (event: AttachmentEvent) => void;
  /** User files to attach; any file switches the request to multipart. */
  files?: readonly File[];
  /** Fired once when the server accepted the request (files validated), before streaming. */
  onAccepted?: () => void;
}

type MessageBodyInput = Pick<
  SendMessageInput,
  'parentId' | 'text' | 'model' | 'namingModel' | 'files'
>;

/**
 * Request body of `POST /messages`: the unchanged JSON body without files, otherwise
 * multipart with the `payload` field first and one `files` part per file. No content-type
 * is set for multipart, so the browser adds the boundary.
 * Seam: a future `urls` list goes into `payload`.
 */
export function buildMessageBody(input: MessageBodyInput): {
  body: string | FormData;
  headers: Record<string, string>;
} {
  const { files, parentId, text, model, namingModel } = input;
  if (!files || files.length === 0)
    return {
      body: JSON.stringify({ parentId, text, model, namingModel }),
      headers: { 'content-type': 'application/json' },
    };
  const payload: MessagePayload = { parentId, text, model, namingModel };
  const form = new FormData();
  form.append(MESSAGE_PAYLOAD_FIELD, JSON.stringify(payload));
  for (const file of files) form.append(MESSAGE_FILES_FIELD, file, file.name);
  return { body: form, headers: {} };
}

const STREAM_EVENTS = new Set(['chunk', 'attachment', 'done', 'error']);

/**
 * Stream an answer. Resolves with the new node id, its committed attachments and user files;
 * throws `ApiError` on failure. Unknown events are ignored.
 */
export async function sendMessage(input: SendMessageInput): Promise<MessageDone> {
  const { treeId, signal, onChunk, onAttachment, onAccepted } = input;
  const { body, headers } = buildMessageBody(input);
  const res = await fetch(`/api${tree(treeId)}/messages`, {
    method: 'POST',
    headers,
    body,
    signal,
  });
  if (!res.ok) throw await errorOf(res);
  onAccepted?.();
  if (!res.body) throw new ApiError(500, i18n.t('errors.emptyResponse'));
  for await (const event of readSse(res.body)) {
    if (!STREAM_EVENTS.has(event.event)) continue;
    const data = JSON.parse(event.data) as unknown;
    if (event.event === 'chunk') onChunk(data as string);
    else if (event.event === 'attachment') onAttachment?.(data as AttachmentEvent);
    else if (event.event === 'done') {
      const done = data as {
        nodeId: string;
        attachments?: AttachmentInfo[];
        files?: UserFileInfo[];
      };
      return {
        nodeId: done.nodeId,
        attachments: done.attachments ?? [],
        files: done.files ?? [],
      };
    } else if (event.event === 'error')
      throw new ApiError(500, (data as { message: string }).message);
  }
  throw new ApiError(500, i18n.t('errors.streamEnded'));
}
