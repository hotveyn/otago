import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { TreeMeta } from '../../api/types';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';

interface TreeListProps {
  trees: TreeMeta[];
  error: unknown;
  currentId: string | null;
  onSelect: (id: string) => void;
}

export function TreeList({ trees, error, currentId, onSelect }: TreeListProps) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
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
        <h3>Trees</h3>
        {!creating && (
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            + New
          </Button>
        )}
      </header>
      <ErrorNote error={error} />
      {trees.length === 0 && !creating && !error && <p className="muted small">No trees yet.</p>}
      <ul className="list">
        {trees.map((tree) => (
          <li key={tree.id}>
            <button
              type="button"
              className={tree.id === currentId ? 'list-item active' : 'list-item'}
              onClick={() => onSelect(tree.id)}
              title={tree.id}
            >
              {tree.title}
            </button>
          </li>
        ))}
      </ul>
      {creating && (
        <form className="stack" onSubmit={submit}>
          <input
            className="input"
            placeholder="Tree title, e.g. Rust basics"
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
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
