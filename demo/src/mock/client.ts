/**
 * Stand-in for `web/src/api/client.ts`: `demo/vite.config.ts` points every import of the real
 * module here. Errors and body helpers are the real ones; `api` and the file URLs are served
 * by the in-browser mock backend.
 */
import type * as Real from '../../../web/src/api/client';
import { demo } from './runtime';

export type { ApiErrorCode, QuestionBodyInput } from '../../../web/src/api/client';
export { ApiError, buildQuestionBody, isApiError } from '../../../web/src/api/client';

export const api: typeof Real.api = demo.api;

export const sourceUrl: typeof Real.sourceUrl = (treeId, file) => demo.urls.source(treeId, file);

/** `download` is ignored: `<a download>` names the file, blob URLs carry no headers. */
export const nodeFileUrl: typeof Real.nodeFileUrl = (folder, treeId, nodeId, name) =>
  demo.urls.nodeFile(folder, treeId, nodeId, name);

export const attachmentUrl: typeof Real.attachmentUrl = (treeId, nodeId, name) =>
  nodeFileUrl('attachments', treeId, nodeId, name);

export const userFileUrl: typeof Real.userFileUrl = (treeId, nodeId, name) =>
  nodeFileUrl('files', treeId, nodeId, name);

// Compile-time guard: this module must export everything the real client exports.
type Missing = Exclude<keyof typeof Real, keyof typeof import('./client')>;
export const exportsComplete: [Missing] extends [never] ? true : Missing = true;
