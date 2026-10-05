import { MESSAGE_FILES_FIELD, MESSAGE_PAYLOAD_FIELD } from '../lib/chat-files';
import type {
  ChainNode,
  ConflictCode,
  DeleteResult,
  ErrorBody,
  FileFolder,
  MessageUploadErrorCode,
  ModelsInfo,
  MoveResult,
  NotFoundCode,
  QuestionContext,
  QuestionErrorCode,
  QuestionInfo,
  RenameNodeResult,
  RestoreResult,
  RetryQuestionResponse,
  SourceInfo,
  StartQuestionPayload,
  StartQuestionResponse,
  TreeDetail,
  TreeMeta,
  UpdateTreeResult,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set for 409 conflicts, 404 reasons, upload rejections and question errors (if sent). */
    readonly code?: ApiErrorCode,
    /** `details` of the error body, for every status (e.g. `TreeBusyDetails` on a 409). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiErrorCode = ConflictCode | MessageUploadErrorCode | NotFoundCode | QuestionErrorCode;

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

const NOT_FOUND_CODES: readonly string[] = [
  'node_not_found',
  'parent_not_found',
  'trash_not_found',
  'tree_not_found',
] satisfies NotFoundCode[];

const QUESTION_ERROR_CODES: readonly string[] = [
  'question_not_found',
  'question_finished',
  'question_not_failed',
] satisfies QuestionErrorCode[];

const isErrorCode = (value: unknown): value is ApiErrorCode =>
  typeof value === 'string' &&
  (CONFLICT_CODES.includes(value) ||
    UPLOAD_ERROR_CODES.includes(value) ||
    NOT_FOUND_CODES.includes(value) ||
    QUESTION_ERROR_CODES.includes(value));

/** True for an `ApiError` with this status (and code, when given). */
export const isApiError = (error: unknown, status: number, code?: ApiErrorCode): boolean =>
  error instanceof ApiError &&
  error.status === status &&
  (code === undefined || error.code === code);

async function errorOf(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  let code: ApiErrorCode | undefined;
  let details: unknown;
  try {
    const body = (await res.json()) as Partial<ErrorBody>;
    if (body.error) message = body.error;
    if (isErrorCode(body.code)) code = body.code;
    details = body.details;
  } catch {
    // Not JSON; keep the status line.
  }
  return new ApiError(res.status, message, code, details);
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
  /** A `title` in the patch may rename the tree folder: the result carries the new `id`. */
  updateTree: (id: string, patch: { title?: string; instructions?: string }) =>
    request<Omit<UpdateTreeResult, 'previous'> & Partial<Pick<UpdateTreeResult, 'previous'>>>(
      tree(id),
      json('PATCH', patch),
      // Defensive: an older server does not report `previous` (and never renames).
    ).then((r): UpdateTreeResult => ({ ...r, previous: r.previous ?? { id, title: r.title } })),
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
    request<Partial<DeleteResult> & Pick<DeleteResult, 'nodes'>>(
      `${tree(id)}/nodes/delete`,
      json('POST', { ids }),
      // Defensive: an older server does not report trash ids (then nothing can be undone).
    ).then((r): DeleteResult => ({ deleted: r.deleted ?? {}, nodes: r.nodes })),
  /** `names` (selected id → desired folder name) is omitted from the body when undefined. */
  moveNodes: (id: string, ids: string[], targetParentId: string, names?: Record<string, string>) =>
    request<MoveResult>(`${tree(id)}/nodes/move`, json('POST', { ids, targetParentId, names })),
  restoreNodes: (id: string, trashIds: string[]) =>
    request<RestoreResult>(`${tree(id)}/nodes/restore`, json('POST', { trashIds })),
  renameNode: (id: string, nodeId: string, name: string) =>
    request<RenameNodeResult>(`${tree(id)}/nodes/rename`, json('POST', { id: nodeId, name })),

  getModels: () => request<ModelsInfo>('/models'),

  /**
   * Start a question (202). Resolves once the server registered it (files validated and
   * staged); the answer then arrives on the question event stream. `signal` aborts the upload.
   */
  startQuestion: (treeId: string, input: QuestionBodyInput, signal?: AbortSignal) => {
    const { body, headers } = buildQuestionBody(input);
    return request<StartQuestionResponse>(`${tree(treeId)}/questions`, {
      method: 'POST',
      body,
      headers,
      signal,
    }).then((r): QuestionInfo => r.question);
  },
  /** Cancel a running question or dismiss a failed one (204). */
  cancelQuestion: (id: string) =>
    request<void>(`/questions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Re-run a failed question (202): same id, `attempt + 1`. */
  retryQuestion: (id: string) =>
    request<RetryQuestionResponse>(`/questions/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    }).then((r): QuestionInfo => r.question),
};

/** What a panel sends: `files` switch the request to multipart. */
export interface QuestionBodyInput {
  parentId: string;
  text: string;
  model?: string;
  namingModel?: string;
  context: QuestionContext;
  files?: readonly File[];
}

/**
 * Request body of `POST /trees/:tree/questions`: JSON without files, otherwise multipart with
 * the `payload` field first and one `files` part per file. No content-type is set for
 * multipart, so the browser adds the boundary. Seam: a future `urls` list goes into `payload`.
 */
export function buildQuestionBody(input: QuestionBodyInput): {
  body: string | FormData;
  headers: Record<string, string>;
} {
  const { files, parentId, text, model, namingModel, context } = input;
  if (!files || files.length === 0)
    return {
      body: JSON.stringify({ parentId, text, model, namingModel, context }),
      headers: { 'content-type': 'application/json' },
    };
  const payload: StartQuestionPayload = { parentId, text, model, namingModel, context };
  const form = new FormData();
  form.append(MESSAGE_PAYLOAD_FIELD, JSON.stringify(payload));
  for (const file of files) form.append(MESSAGE_FILES_FIELD, file, file.name);
  return { body: form, headers: {} };
}
