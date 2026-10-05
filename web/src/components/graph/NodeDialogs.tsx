import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { HierarchyNode } from '../../api/types';
import { describeError } from '../../lib/chat-errors';
import { canSubmitRename, MAX_NAME_LENGTH } from '../../lib/rename';
import { canMoveTo, countWithDescendants, flatten, parentIdOf, topLevelIds } from '../../lib/tree';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ErrorNote } from '../ui/ErrorNote';
import { IdPath } from '../ui/IdPath';

interface DeleteDialogProps {
  open: boolean;
  nodes: HierarchyNode[];
  selection: string[];
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteDialog({
  open,
  nodes,
  selection,
  pending,
  error,
  onConfirm,
  onClose,
}: DeleteDialogProps) {
  const { t } = useTranslation(['graph', 'common']);
  const top = topLevelIds(selection);
  const total = countWithDescendants(nodes, selection);
  const descendants = total - top.length;
  return (
    <Dialog
      open={open}
      title={t('delete.title', { count: top.length })}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? t('delete.deleting') : t('delete.confirm', { count: total })}
          </Button>
        </>
      }
    >
      <p>
        <Trans
          t={t}
          i18nKey={descendants > 0 ? 'delete.bodyNested' : 'delete.body'}
          count={total}
          values={{
            selected: top.length,
            descendants: t('delete.descendants', { count: descendants }),
          }}
          components={{ strong: <strong /> }}
        />
      </p>
      <ul className="id-list">
        {top.map((id) => (
          <li key={id}>
            <IdPath id={id} />
          </li>
        ))}
      </ul>
      <ErrorNote error={error} message={describeError(error).message} />
    </Dialog>
  );
}

interface MoveDialogProps {
  open: boolean;
  title: string;
  nodes: HierarchyNode[];
  selection: string[];
  pending: boolean;
  error: unknown;
  onConfirm: (targetId: string) => void;
  onClose: () => void;
}

export function MoveDialog({
  open,
  title,
  nodes,
  selection,
  pending,
  error,
  onConfirm,
  onClose,
}: MoveDialogProps) {
  const { t } = useTranslation(['graph', 'common']);
  const [target, setTarget] = useState<string | null>(null);
  const top = topLevelIds(selection);
  const alreadyThere = (id: string) => top.every((selected) => parentIdOf(selected) === id);
  const options = [{ id: '', label: title, depth: 0, isRoot: true }].concat(
    flatten(nodes).map(({ node, depth }) => ({
      id: node.id,
      label: node.name,
      depth: depth + 1,
      isRoot: false,
    })),
  );
  const close = () => {
    setTarget(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      wide
      title={t('move.title', { count: top.length })}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common:cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={target === null || pending}
            onClick={() => target !== null && onConfirm(target)}
          >
            {pending ? t('move.moving') : t('move.confirm')}
          </Button>
        </>
      }
    >
      <p className="muted small">{t('move.hint')}</p>
      <ul className="target-list">
        {options.map((option) => {
          const valid = canMoveTo(selection, option.id) && !alreadyThere(option.id);
          const classes = [
            'target',
            option.id === target ? 'target-active' : '',
            option.isRoot ? 'target-root' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={option.id || '__root__'}>
              <button
                type="button"
                dir="auto"
                className={classes}
                style={{ paddingLeft: 8 + option.depth * 13 }}
                disabled={!valid}
                onClick={() => setTarget(option.id)}
              >
                {option.label}
              </button>
            </li>
          );
        })}
      </ul>
      <ErrorNote error={error} message={describeError(error).message} />
    </Dialog>
  );
}

interface RenameDialogProps {
  open: boolean;
  /** Current folder name of the node; the input starts with it. */
  currentName: string;
  pending: boolean;
  error: unknown;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function RenameDialog({
  open,
  currentName,
  pending,
  error,
  onConfirm,
  onClose,
}: RenameDialogProps) {
  const { t } = useTranslation(['graph', 'common']);
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  /** `null` until the user types: shows the current name. */
  const [value, setValue] = useState<string | null>(null);
  const shown = value ?? currentName;
  const valid = canSubmitRename(currentName, shown);

  useEffect(() => {
    if (!open) {
      setValue(null);
      return;
    }
    // After `showModal()` moved focus into the dialog.
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !pending) onConfirm(shown);
  };

  return (
    <Dialog
      open={open}
      title={t('renameDialog.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={!valid || pending}>
            {pending ? t('renameDialog.saving') : t('renameDialog.confirm')}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field-label">{t('renameDialog.label')}</span>
          <input
            ref={input}
            className="input"
            value={shown}
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => setValue(event.target.value)}
          />
          <span className="field-hint">{t('renameDialog.hint')}</span>
        </label>
      </form>
      <ErrorNote error={error} message={describeError(error).message} />
    </Dialog>
  );
}
