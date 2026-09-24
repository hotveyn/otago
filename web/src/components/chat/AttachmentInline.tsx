import { type ReactNode, useState } from 'react';
import { attachmentUrl } from '../../api/client';
import type { AttachmentInfo } from '../../api/types';
import {
  canPreview,
  extensionOf,
  isImageKind,
  PREVIEW_LIMITS,
  resolveAttachment,
} from '../../lib/attachments';
import { useOpenAttachment } from '../source-viewer-context';
import { useAttachmentScope } from './attachment-scope';

export function KindBadge({ name }: { name: string }) {
  return <span className="file-badge">{extensionOf(name) || 'file'}</span>;
}

export function BrokenAttachment({ name, message }: { name: string; message?: string }) {
  return (
    <span className="attachment-broken" role="note">
      {message ?? `Attachment not found: ${name}`}
    </span>
  );
}

function PendingChip({ name, label }: { name: string; label: string }) {
  return (
    <span className="attachment-chip attachment-chip-pending">
      <KindBadge name={name} />
      <span className="truncate">{name}</span>
      <span className="muted small">· {label}</span>
    </span>
  );
}

/** A committed attachment as an inline chip: opens the viewer, or downloads (`other`). */
function ReadyChip({
  treeId,
  nodeId,
  info,
  children,
}: {
  treeId: string;
  nodeId: string;
  info: AttachmentInfo;
  children: ReactNode;
}) {
  const openAttachment = useOpenAttachment();
  if (!canPreview(info)) {
    return (
      <a
        className="attachment-chip"
        href={attachmentUrl(treeId, nodeId, info.name, true)}
        download={info.name}
      >
        <KindBadge name={info.name} />
        <span>{children}</span>
      </a>
    );
  }
  return (
    <button
      type="button"
      className="attachment-chip"
      title={info.name}
      onClick={() => openAttachment({ treeId, nodeId, attachment: info })}
    >
      <KindBadge name={info.name} />
      <span>{children}</span>
    </button>
  );
}

/** `[label](attachments/<name>)` in the answer text. */
export function AttachmentLink({ name, children }: { name: string; children?: ReactNode }) {
  const scope = useAttachmentScope();
  const label = children ?? name;
  if (!scope) return <span className="attachment-chip attachment-chip-pending">{label}</span>;
  const resolved = resolveAttachment(scope, name);
  switch (resolved.state) {
    case 'ready':
      return scope.nodeId ? (
        <ReadyChip treeId={scope.treeId} nodeId={scope.nodeId} info={resolved.info}>
          {label}
        </ReadyChip>
      ) : null;
    case 'staged':
      return <PendingChip name={name} label={scope.unsaved ? 'not saved' : 'ready'} />;
    case 'saving':
      return <PendingChip name={name} label="saving…" />;
    case 'failed':
      return <BrokenAttachment name={name} message={`${name}: ${resolved.message}`} />;
    default:
      return <BrokenAttachment name={name} />;
  }
}

function InlineImage({
  url,
  downloadUrl,
  info,
  alt,
}: {
  url: string;
  downloadUrl: string;
  info: AttachmentInfo;
  alt: string;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <BrokenAttachment name={info.name} />;
  return (
    <span className={`md-attachment md-attachment-${info.kind}`}>
      <img
        className="md-attachment-img"
        src={url}
        alt={alt || info.name}
        loading="lazy"
        onError={() => setBroken(true)}
      />
      <span className="md-attachment-caption muted small">
        {alt && <span>{alt} · </span>}
        <a href={downloadUrl} download={info.name}>
          Download
        </a>
      </span>
    </span>
  );
}

/** `![alt](attachments/<name>)` in the answer text. SVG only via <img>, so it never runs. */
export function AttachmentImage({ name, alt }: { name: string; alt?: string }) {
  const scope = useAttachmentScope();
  if (!scope) return <BrokenAttachment name={name} />;
  const resolved = resolveAttachment(scope, name);
  if (resolved.state === 'ready' && scope.nodeId) {
    const { info } = resolved;
    if (isImageKind(info) && info.size <= PREVIEW_LIMITS.imageBytes) {
      return (
        <InlineImage
          url={resolved.url}
          downloadUrl={attachmentUrl(scope.treeId, scope.nodeId, name, true)}
          info={info}
          alt={alt ?? ''}
        />
      );
    }
    return <AttachmentLink name={name}>{alt || name}</AttachmentLink>;
  }
  return <AttachmentLink name={name}>{alt || name}</AttachmentLink>;
}
