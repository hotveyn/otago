import { readSse } from './sse';
import type {
  AttachmentEvent,
  AttachmentInfo,
  ChainNode,
  HierarchyNode,
  MessageDone,
  ModelsInfo,
  MoveResult,
  SourceInfo,
  TreeDetail,
  TreeMeta,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // Not JSON; keep the status line.
  }
  return new ApiError(res.status, message);
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

/** Contract URL recipe for a committed node's attachment. */
export const attachmentUrl = (treeId: string, nodeId: string, name: string, download = false) =>
  `/api${tree(treeId)}/attachments?node=${encodeURIComponent(nodeId)}&name=${encodeURIComponent(name)}${
    download ? '&download=1' : ''
  }`;

async function fetchAttachment(treeId: string, nodeId: string, name: string): Promise<Response> {
  const res = await fetch(attachmentUrl(treeId, nodeId, name));
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
      // Defensive: an older server omits the field.
      (r) => r.chain.map((item) => ({ ...item, attachments: item.attachments ?? [] })),
    ),
  getAttachmentText: (id: string, node: string, name: string) =>
    fetchAttachment(id, node, name).then((res) => res.text()),
  getAttachmentBlob: (id: string, node: string, name: string) =>
    fetchAttachment(id, node, name).then((res) => res.blob()),

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
}

const STREAM_EVENTS = new Set(['chunk', 'attachment', 'done', 'error']);

/**
 * Stream an answer. Resolves with the new node id and its committed attachments;
 * throws `ApiError` on failure. Unknown events are ignored.
 */
export async function sendMessage(input: SendMessageInput): Promise<MessageDone> {
  const { treeId, signal, onChunk, onAttachment, ...body } = input;
  const res = await fetch(`/api${tree(treeId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorOf(res);
  if (!res.body) throw new ApiError(500, 'Empty response');
  for await (const event of readSse(res.body)) {
    if (!STREAM_EVENTS.has(event.event)) continue;
    const data = JSON.parse(event.data) as unknown;
    if (event.event === 'chunk') onChunk(data as string);
    else if (event.event === 'attachment') onAttachment?.(data as AttachmentEvent);
    else if (event.event === 'done') {
      const done = data as { nodeId: string; attachments?: AttachmentInfo[] };
      return { nodeId: done.nodeId, attachments: done.attachments ?? [] };
    } else if (event.event === 'error')
      throw new ApiError(500, (data as { message: string }).message);
  }
  throw new ApiError(500, 'Stream ended without an answer');
}
