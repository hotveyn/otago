/** Attachment constants (mirrored from the rich-answers contract) and pure helpers. */
import { attachmentUrl } from '../api/client';
import type { AttachmentEvent, AttachmentInfo, AttachmentOrigin } from '../api/types';

/** Answer text references an attachment of the same node as `attachments/<name>`. */
export const ATTACHMENT_LINK_PREFIX = 'attachments/';

/** Final (sanitized) attachment names always match this pattern. */
export const ATTACHMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** Client-side preview thresholds. Above them the UI shows metadata + Download only. */
export const PREVIEW_LIMITS = {
  imageBytes: 20 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024,
  tableBytes: 10 * 1024 * 1024,
  tableRows: 5_000,
  pdfBytes: 50 * 1024 * 1024,
} as const;

/** One file of a streaming answer, reduced from `attachment` SSE events. */
export interface StreamingAttachment {
  key: string;
  status: 'saving' | 'ready' | 'failed';
  requestedName?: string;
  origin?: AttachmentOrigin;
  attachment?: AttachmentInfo;
  message?: string;
}

/** What an answer's attachment references resolve against. */
export interface AttachmentScopeValue {
  treeId: string;
  /** Committed node id; `null` while the answer is streaming (or was not saved). */
  nodeId: string | null;
  /** Committed attachments of `nodeId`. */
  attachments: AttachmentInfo[];
  /** Live list of a streaming answer; `null` for committed nodes. */
  streaming: StreamingAttachment[] | null;
  /** The streaming answer failed or was stopped: nothing was written. */
  unsaved?: boolean;
}

export type Resolved =
  | { state: 'ready'; info: AttachmentInfo; url: string }
  | { state: 'staged'; info: AttachmentInfo }
  | { state: 'saving' }
  | { state: 'failed'; message: string }
  | { state: 'missing' };

/** `attachments/a%20b.csv` or `./attachments/x.svg` -> decoded name; anything else -> null. */
export function parseAttachmentHref(href: string | undefined | null): string | null {
  if (!href) return null;
  const path = href.startsWith('./') ? href.slice(2) : href;
  if (!path.startsWith(ATTACHMENT_LINK_PREFIX)) return null;
  const rest = path.slice(ATTACHMENT_LINK_PREFIX.length);
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/** Reduce one SSE event into the list. First-seen order; unknown keys are inserted. */
export function applyAttachmentEvent(
  list: StreamingAttachment[],
  event: AttachmentEvent,
): StreamingAttachment[] {
  const index = list.findIndex((item) => item.key === event.key);
  const previous = index === -1 ? undefined : list[index];
  let next: StreamingAttachment;
  if (event.status === 'saving') {
    next = {
      key: event.key,
      status: 'saving',
      requestedName: event.requestedName,
      origin: event.origin,
    };
  } else if (event.status === 'ready') {
    next = {
      ...previous,
      key: event.key,
      status: 'ready',
      origin: event.attachment.origin ?? previous?.origin,
      attachment: event.attachment,
    };
  } else {
    next = {
      ...previous,
      key: event.key,
      status: 'failed',
      requestedName: event.requestedName ?? previous?.requestedName,
      message: event.message,
    };
  }
  if (index === -1) return [...list, next];
  return list.map((item, i) => (i === index ? next : item));
}

/** Resolve an in-text `attachments/<name>` reference against the answer's scope. */
export function resolveAttachment(scope: AttachmentScopeValue, name: string): Resolved {
  if (scope.nodeId !== null) {
    const info = scope.attachments.find((item) => item.name === name);
    return info
      ? { state: 'ready', info, url: attachmentUrl(scope.treeId, scope.nodeId, name) }
      : { state: 'missing' };
  }
  const items = scope.streaming ?? [];
  const staged = items.find((item) => item.status === 'ready' && item.attachment?.name === name);
  if (staged?.attachment) return { state: 'staged', info: staged.attachment };
  const byRequest = items.find((item) => item.requestedName === name);
  if (byRequest?.status === 'failed')
    return { state: 'failed', message: byRequest.message ?? 'Not saved' };
  if (scope.unsaved) return { state: 'missing' };
  // The agent may reference a file before its tool call finishes: stay neutral while streaming.
  return { state: 'saving' };
}

/** Whether the attachment has a preview within PREVIEW_LIMITS. */
export function canPreview(info: AttachmentInfo): boolean {
  switch (info.kind) {
    case 'image':
    case 'svg':
      return info.size <= PREVIEW_LIMITS.imageBytes;
    case 'table':
      return info.size <= PREVIEW_LIMITS.tableBytes;
    case 'text':
      return info.size <= PREVIEW_LIMITS.textBytes;
    case 'pdf':
      return info.size <= PREVIEW_LIMITS.pdfBytes;
    default:
      return false;
  }
}

export function isImageKind(info: AttachmentInfo): boolean {
  return info.kind === 'image' || info.kind === 'svg';
}

/** Lower-case extension without the dot, or '' when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const UNITS = ['KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}
