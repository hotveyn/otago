import type { Element, ElementContent } from 'hast';
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useMemo,
} from 'react';
import { SortButton, TableBar, useTableView } from './table-controls';

type Props = { children?: ReactNode; [key: string]: unknown };

function textOf(node: ElementContent | Element): string {
  if (node.type === 'text') return node.value;
  if ('children' in node)
    return node.children.map((child) => textOf(child as ElementContent)).join('');
  return '';
}

const elements = (node: Element | undefined, tag?: string): Element[] =>
  (node?.children ?? []).filter(
    (child): child is Element => child.type === 'element' && (!tag || child.tagName === tag),
  );

const reactElements = (children: ReactNode, tag?: string): ReactElement<Props>[] =>
  Children.toArray(children).filter(
    (child): child is ReactElement<Props> => isValidElement(child) && (!tag || child.type === tag),
  );

interface Structure {
  header: string[];
  rows: string[][];
  thead: ReactElement<Props>;
  headRow: ReactElement<Props>;
  headCells: ReactElement<Props>[];
  bodyRows: ReactElement<Props>[];
}

/** Align react-markdown's rendered table with its hast node; `null` when they disagree. */
function readStructure(node: Element | undefined, children: ReactNode): Structure | null {
  const hastHead = elements(node, 'thead')[0];
  const hastHeadRow = elements(hastHead, 'tr')[0];
  const hastRows = elements(elements(node, 'tbody')[0], 'tr');
  if (!hastHeadRow) return null;

  const thead = reactElements(children, 'thead')[0];
  const headRow = reactElements(thead?.props.children, 'tr')[0];
  const headCells = reactElements(headRow?.props.children);
  const tbody = reactElements(children, 'tbody')[0];
  const bodyRows = reactElements(tbody?.props.children, 'tr');
  if (!thead || !headRow) return null;

  const header = elements(hastHeadRow).map((cell) => textOf(cell).trim());
  if (headCells.length !== header.length || bodyRows.length !== hastRows.length) return null;
  const rows = hastRows.map((row) => elements(row).map((cell) => textOf(cell).trim()));
  return { header, rows, thead, headRow, headCells, bodyRows };
}

function PlainTable({ children }: { children?: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  );
}

function Controlled({ structure }: { structure: Structure }) {
  const { header, rows, thead, headRow, headCells, bodyRows } = structure;
  const { order, query, setQuery, cycle, ariaSort } = useTableView(rows);
  const cells = headCells.map((cell, column) =>
    cloneElement(
      cell,
      { 'aria-sort': ariaSort(column) },
      <SortButton
        label={cell.props.children}
        sort={ariaSort(column)}
        onClick={() => cycle(column)}
      />,
    ),
  );
  return (
    <div className="data-table">
      <TableBar
        query={query}
        onQuery={setQuery}
        shown={order.length}
        total={rows.length}
        header={header}
        rows={rows}
        order={order}
        baseName="table"
      />
      <div className="table-wrap">
        <table>
          {cloneElement(thead, {}, cloneElement(headRow, {}, cells))}
          <tbody>{order.map((index) => bodyRows[index])}</tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * GFM table with sort / filter / Export CSV that keeps react-markdown's rendered cells.
 * Falls back to a plain table when the structure is unexpected or has fewer than 2 rows.
 */
export function SmartTable({ node, children }: { node?: Element; children?: ReactNode }) {
  const structure = useMemo(() => readStructure(node, children), [node, children]);
  if (!structure || structure.rows.length < 2) return <PlainTable>{children}</PlainTable>;
  return <Controlled structure={structure} />;
}
