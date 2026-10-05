import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { dropTreeCaches, keys, moveTreeCaches } from '../../api/queries';
import type { TreeDetail } from '../../api/types';
import { treeBusyDetailsOf } from '../../lib/blockers';
import { describeError } from '../../lib/chat-errors';
import { MAX_NAME_LENGTH, type TreePatch, treePatchOf } from '../../lib/rename';
import { safeSession } from '../../lib/storage';
import { renameHistoryKey } from '../../lib/undo-history';
import { useShowBlockers } from '../graph/blockers-context';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';

interface TreeSettingsProps {
  tree: TreeDetail;
  /** A title change renamed the tree folder: `from` no longer exists, `to` does. */
  onRenamed?: (from: string, to: string) => void;
}

export function TreeSettings({ tree, onRenamed }: TreeSettingsProps) {
  const { t } = useTranslation(['sidebar', 'graph']);
  const queryClient = useQueryClient();
  const showBlockers = useShowBlockers();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(tree.title);
  const [instructions, setInstructions] = useState(tree.instructions);
  // Only changed fields: a `title` takes the tree's exclusive lock (it renames the folder).
  const patch = treePatchOf(tree, title, instructions);
  const dirty = patch !== null;

  const save = useMutation({
    mutationFn: (next: TreePatch) => api.updateTree(tree.id, next),
    onSuccess: ({ previous: _previous, ...updated }) => {
      const oldId = tree.id;
      if (updated.id === oldId) {
        queryClient.setQueryData<TreeDetail>(keys.tree(oldId), (old) =>
          old ? { ...old, ...updated } : old,
        );
        void queryClient.invalidateQueries({ queryKey: keys.trees });
        setTitle(updated.title);
        setInstructions(updated.instructions);
        return;
      }
      // Seed the new id, carry the undo stack over, then switch the URL (this remounts the
      // settings under the new key). Old-id caches go only after that render, so nothing
      // refetches the vanished id while it is still on screen.
      moveTreeCaches(queryClient, oldId, updated);
      renameHistoryKey(safeSession, oldId, updated.id);
      onRenamed?.(oldId, updated.id);
      void queryClient.invalidateQueries({ queryKey: keys.trees });
      setTimeout(() => dropTreeCaches(queryClient, oldId), 0);
    },
    // A title rename takes the tree's exclusive lock: running answers block it.
    onError: (error, next) => {
      if (!treeBusyDetailsOf(error)) return;
      showBlockers({
        tree: tree.id,
        error,
        retry: { label: t('graph:blockers.retry.renameTree'), run: () => save.mutate(next) },
      });
    },
  });
  const saveError = treeBusyDetailsOf(save.error) ? null : save.error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (patch) save.mutate(patch);
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
              maxLength={MAX_NAME_LENGTH}
            />
            <span className="field-hint">{t('settings.titleHint')}</span>
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
          <ErrorNote error={saveError} message={describeError(saveError).message} />
          <div className="row">
            <Button type="submit" size="sm" variant="primary" disabled={!dirty || save.isPending}>
              {save.isPending ? t('settings.saving') : t('settings.save')}
            </Button>
            {save.isSuccess && !dirty && <span className="muted small">{t('settings.saved')}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
