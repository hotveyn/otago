/**
 * In-memory drafts per chat (`<tree>:main`, `<tree>:side:<anchor>`): a panel writes its draft
 * here on unmount and reads it on mount; failed sends whose panel is gone land here too.
 * `File` objects never leave memory (nothing is persisted).
 */
import type { QuestionContext } from '../api/types';
import { type ComposerFile, restoreFiles } from './chat-files';

export interface Draft {
  text: string;
  files: ComposerFile[];
}

export const stashKeyOf = (tree: string, context: QuestionContext): string =>
  context.kind === 'main' ? `${tree}:main` : `${tree}:side:${context.anchor}`;

export const isEmptyDraft = (draft: Draft): boolean =>
  draft.text.trim() === '' && draft.files.length === 0;

/** Restore `restored` into `current`: a non-empty current text wins; files as `restoreFiles`. */
export function mergeDraft(current: Draft | null, restored: Draft): Draft {
  return {
    text: current && current.text.trim() !== '' ? current.text : restored.text,
    files: restoreFiles(current?.files ?? [], restored.files),
  };
}

export interface DraftStash {
  get(key: string): Draft | null;
  /** `null` or an empty draft deletes the key. */
  set(key: string, draft: Draft | null): void;
  clear(): void;
}

export function createDraftStash(): DraftStash {
  const drafts = new Map<string, Draft>();
  return {
    get: (key) => drafts.get(key) ?? null,
    set(key, draft) {
      if (draft === null || isEmptyDraft(draft)) drafts.delete(key);
      else drafts.set(key, draft);
    },
    clear: () => drafts.clear(),
  };
}

/** The tab's stash. */
export const draftStash: DraftStash = createDraftStash();
