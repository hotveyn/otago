import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { TreeDetail } from '../../api/types';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';

export function TreeSettings({ tree }: { tree: TreeDetail }) {
  const { t } = useTranslation('sidebar');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(tree.title);
  const [instructions, setInstructions] = useState(tree.instructions);
  const dirty = title.trim() !== tree.title || instructions.trim() !== tree.instructions;

  const save = useMutation({
    mutationFn: () => api.updateTree(tree.id, { title: title.trim(), instructions }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TreeDetail>(keys.tree(tree.id), (old) =>
        old ? { ...old, ...updated } : old,
      );
      void queryClient.invalidateQueries({ queryKey: keys.trees });
      setTitle(updated.title);
      setInstructions(updated.instructions);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dirty && title.trim()) save.mutate();
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <button
          type="button"
          className="disclosure"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="disclosure-mark">{open ? '−' : '+'}</span>
          <h3>{t('settings.title')}</h3>
        </button>
        {!open && tree.instructions && (
          <span className="muted small">{t('settings.instructionsSet')}</span>
        )}
      </header>
      {open && (
        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span className="field-label">{t('settings.fieldTitle')}</span>
            <input
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('settings.fieldInstructions')}</span>
            <textarea
              className="input textarea"
              rows={6}
              value={instructions}
              placeholder={t('settings.instructionsPlaceholder')}
              onChange={(event) => setInstructions(event.target.value)}
            />
            <span className="field-hint">{t('settings.instructionsHint')}</span>
          </label>
          <ErrorNote error={save.error} />
          <div className="row">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!dirty || !title.trim() || save.isPending}
            >
              {save.isPending ? t('settings.saving') : t('settings.save')}
            </Button>
            {save.isSuccess && !dirty && <span className="muted small">{t('settings.saved')}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
