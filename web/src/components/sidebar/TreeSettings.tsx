import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { TreeDetail } from '../../api/types';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';

export function TreeSettings({ tree }: { tree: TreeDetail }) {
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
          <h3>Settings</h3>
        </button>
        {!open && tree.instructions && <span className="muted small">instructions set</span>}
      </header>
      {open && (
        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span className="field-label">Title</span>
            <input
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
            />
          </label>
          <label className="field">
            <span className="field-label">Instructions</span>
            <textarea
              className="input textarea"
              rows={6}
              value={instructions}
              placeholder="Answer in Russian. I know C++, compare with it where useful."
              onChange={(event) => setInstructions(event.target.value)}
            />
            <span className="field-hint">Added to the system prompt on every question.</span>
          </label>
          <ErrorNote error={save.error} />
          <div className="row">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!dirty || !title.trim() || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {save.isSuccess && !dirty && <span className="muted small">Saved</span>}
          </div>
        </form>
      )}
    </section>
  );
}
