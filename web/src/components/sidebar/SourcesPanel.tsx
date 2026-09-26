import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys, useSources } from '../../api/queries';
import type { SourceInfo } from '../../api/types';
import { formatLabel, SOURCE_ACCEPT, viewableFile } from '../../lib/sources';
import { useOpenSource } from '../source-viewer-context';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ErrorNote } from '../ui/ErrorNote';

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SourcesPanel({ treeId }: { treeId: string }) {
  const { t } = useTranslation(['sidebar', 'common']);
  const queryClient = useQueryClient();
  const sources = useSources(treeId);
  const openSource = useOpenSource();
  const input = useRef<HTMLInputElement>(null);
  const [pendingDelete, setPendingDelete] = useState<SourceInfo | null>(null);
  const [dragging, setDragging] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.sources(treeId) });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await api.uploadSource(treeId, file);
    },
    onSettled: async (_data, _error, files) => {
      for (const file of files)
        queryClient.removeQueries({ queryKey: keys.source(treeId, viewableFile(file.name)) });
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.deleteSource(treeId, name),
    onSuccess: async () => {
      setPendingDelete(null);
      await refresh();
    },
  });

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) upload.mutate(files);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file drop zone; the Upload button is the keyboard path
    <section
      className={dragging ? 'panel panel-drop' : 'panel'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="panel-header">
        <h3>{t('sources.title')}</h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => input.current?.click()}
          disabled={upload.isPending}
        >
          {upload.isPending ? t('sources.uploading') : t('sources.upload')}
        </Button>
        <input
          ref={input}
          type="file"
          accept={SOURCE_ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (files.length > 0) upload.mutate(files);
          }}
        />
      </header>
      <ErrorNote
        error={upload.error ?? sources.error}
        onDismiss={upload.error ? upload.reset : undefined}
      />
      {sources.data?.length === 0 && <p className="muted small">{t('sources.empty')}</p>}
      <ul className="list">
        {sources.data?.map((source) => (
          <li key={source.name} className="source-row">
            <button
              type="button"
              className="list-item source-name"
              onClick={() => openSource({ file: source.text ?? source.name })}
              title={t('sources.open', { name: source.name })}
            >
              <span className="file-badge">{formatLabel(source.name)}</span>
              <span className="truncate">{source.name}</span>
            </button>
            <span className="muted small nowrap">{formatSize(source.size)}</span>
            <button
              type="button"
              className="icon-btn row-action"
              aria-label={t('sources.deleteLabel', { name: source.name })}
              onClick={() => setPendingDelete(source)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <Dialog
        open={pendingDelete !== null}
        title={t('sources.deleteTitle')}
        onClose={() => {
          setPendingDelete(null);
          remove.reset();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete.name)}
            >
              {t('common:delete')}
            </Button>
          </>
        }
      >
        <p>
          <Trans
            t={t}
            i18nKey="sources.deleteConfirm"
            values={{ name: pendingDelete?.name }}
            components={{ strong: <strong />, code: <code /> }}
          />
        </p>
        <ErrorNote error={remove.error} />
      </Dialog>
    </section>
  );
}
