import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { TreeMeta } from '../../api/types';
import { useTreeCounts } from '../../lib/question-store';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';

interface TreeListProps {
  trees: TreeMeta[];
  error: unknown;
  currentId: string | null;
  onSelect: (id: string) => void;
}

export function TreeList({ trees, error, currentId, onSelect }: TreeListProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  // Answers keep running in other trees: a badge makes them discoverable.
  const counts = useTreeCounts();
  const create = useMutation({
    mutationFn: (value: string) => api.createTree({ title: value }),
    onSuccess: async (tree) => {
      await queryClient.invalidateQueries({ queryKey: keys.trees });
      setTitle('');
      setCreating(false);
      onSelect(tree.id);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) create.mutate(title.trim());
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <h3>{t('trees.title')}</h3>
        {!creating && (
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            {t('trees.new')}
          </Button>
        )}
      </header>
      <ErrorNote error={error} />
      {trees.length === 0 && !creating && !error && (
        <p className="muted small">{t('trees.empty')}</p>
      )}
      <ul className="list">
        {trees.map((tree) => {
          const running = counts[tree.id]?.running ?? 0;
          const failed = counts[tree.id]?.failed ?? 0;
          return (
            <li key={tree.id}>
              <button
                type="button"
                className={tree.id === currentId ? 'list-item active' : 'list-item'}
                onClick={() => onSelect(tree.id)}
                title={tree.id}
              >
                <span className="list-item-label truncate">{tree.title}</span>
                {running > 0 && (
                  <span className="tree-badge" title={t('trees.running', { count: running })}>
                    <span aria-hidden="true">{running}</span>
                    <span className="visually-hidden">
                      {t('trees.running', { count: running })}
                    </span>
                  </span>
                )}
                {failed > 0 && (
                  <span
                    className="tree-failed"
                    title={t('trees.failed', { count: failed })}
                    role="img"
                    aria-label={t('trees.failed', { count: failed })}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {creating && (
        <form className="stack" onSubmit={submit}>
          <input
            className="input"
            placeholder={t('trees.titlePlaceholder')}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setCreating(false);
            }}
            // biome-ignore lint/a11y/noAutofocus: the field appears on an explicit click
            autoFocus
            maxLength={200}
          />
          <ErrorNote error={create.error} />
          <div className="row">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!title.trim() || create.isPending}
            >
              {t('common:create')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t('common:cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
