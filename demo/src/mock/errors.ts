/**
 * Errors of the mock backend: the same `ApiError` the real client throws, with the statuses,
 * codes and messages of the server (`server/src/errors.ts`, `app.ts` error handler).
 */
import { ApiError, type ApiErrorCode } from '../../../web/src/api/client';

export const badRequest = (message: string, code?: ApiErrorCode, details?: unknown) =>
  new ApiError(400, message, code, details);

export const notFound = (message: string, code?: ApiErrorCode) => new ApiError(404, message, code);

export const conflict = (message: string, code: ApiErrorCode, details?: unknown) =>
  new ApiError(409, message, code, details);

export const payloadTooLarge = (message: string, code?: ApiErrorCode) =>
  new ApiError(413, message, code);

export const treeNotFound = (treeId: string) =>
  notFound(`Tree not found: ${treeId}`, 'tree_not_found');

export const storageFull = () =>
  payloadTooLarge(
    'Demo storage is full: browser storage holds about 5 MB. Delete some files or nodes, or reset the demo.',
  );
