/**
 * The one place that decides what a citation click does (contract §6). Components only
 * perform the returned action: a real anchor for `new-tab` (pop-up safe), the in-app line
 * viewer for `viewer`, nothing for `none`. Future `quote` / `fragment` seams plug in here.
 */
import { sourceUrl, userFileUrl } from '../api/client';
import { type CitationTarget, unitOf, viewableName } from './citations';

export interface CitationScope {
  treeId: string;
  /** The answer's committed node id; `null` while it streams (own-node `files/` unresolved). */
  nodeId: string | null;
}

export type OpenAction =
  | { kind: 'new-tab'; url: string }
  | { kind: 'viewer'; where: 'source'; name: string; start?: number; end?: number }
  | { kind: 'viewer'; where: 'file'; node: string; name: string; start?: number; end?: number }
  | { kind: 'none' };

/** Fragment appended to a PDF URL when a page is cited (ignored by Safari: page 1). */
export const PDF_PAGE_FRAGMENT = (page: number) => `#page=${page}`;

const NONE: OpenAction = { kind: 'none' };

function pageUrl(url: string, start: number | undefined): string {
  return start === undefined ? url : `${url}${PDF_PAGE_FRAGMENT(start)}`;
}

/**
 * Map a target to its action. `scope` is null where no answer scope exists (plain viewers):
 * only URLs and in-app text sources can be opened there.
 */
export function openActionFor(target: CitationTarget, scope: CitationScope | null): OpenAction {
  switch (target.kind) {
    case 'url':
      return { kind: 'new-tab', url: target.url };
    case 'text':
      return NONE;
    case 'source': {
      const file = target.file.normalize('NFC');
      const unit = unitOf(file);
      if (unit === 'line')
        return {
          kind: 'viewer',
          where: 'source',
          name: viewableName(file),
          start: target.start,
          end: target.end,
        };
      if (!scope) return NONE;
      const url = sourceUrl(scope.treeId, file);
      return { kind: 'new-tab', url: unit === 'page' ? pageUrl(url, target.start) : url };
    }
    case 'file': {
      if (!scope) return NONE;
      const node = (target.node ?? scope.nodeId)?.normalize('NFC');
      if (node === undefined) return NONE;
      const name = target.name.normalize('NFC');
      const unit = unitOf(name);
      if (unit === 'line')
        return {
          kind: 'viewer',
          where: 'file',
          node,
          name: viewableName(name),
          start: target.start,
          end: target.end,
        };
      const url = userFileUrl(scope.treeId, node, name);
      return { kind: 'new-tab', url: unit === 'page' ? pageUrl(url, target.start) : url };
    }
  }
}
