import { type ReactNode, useDeferredValue, useMemo, useState } from 'react';
import { downloadText, toCsv } from '../../lib/csv';
import { filterRows, type SortDirection, sortRows } from '../../lib/table';

export interface SortState {
  column: number;
  direction: SortDirection;
}

type AriaSort = 'ascending' | 'descending' | 'none';

/** Sort + filter state over string rows; `order` is the visible row indices. */
export function useTableView(rows: string[][]) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const order = useMemo(() => {
    const matching = filterRows(rows, deferredQuery);
    if (!sort) return matching;
    const keep = new Set(matching);
    return sortRows(rows, sort.column, sort.direction).filter((index) => keep.has(index));
  }, [rows, deferredQuery, sort]);

  /** Header click cycles asc -> desc -> none. */
  const cycle = (column: number) =>
    setSort((current) => {
      if (current?.column !== column) return { column, direction: 'asc' };
      return current.direction === 'asc' ? { column, direction: 'desc' } : null;
    });

  const ariaSort = (column: number): AriaSort =>
    sort?.column === column ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return { order, query, setQuery, cycle, ariaSort };
}

export function SortButton({
  label,
  sort,
  onClick,
}: {
  label: ReactNode;
  sort: AriaSort;
  onClick: () => void;
}) {
  return (
    <button type="button" className="th-sort" onClick={onClick}>
      {label}
      <span className="sort-mark" aria-hidden>
        {sort === 'ascending' ? '▲' : sort === 'descending' ? '▼' : '↕'}
      </span>
    </button>
  );
}

interface TableBarProps {
  query: string;
  onQuery: (query: string) => void;
  shown: number;
  total: number;
  header: string[];
  rows: string[][];
  order: number[];
  baseName: string;
  children?: ReactNode;
}

/** Filter input, "N of M rows", Export CSV (filtered + sorted rows) and extra actions. */
export function TableBar({
  query,
  onQuery,
  shown,
  total,
  header,
  rows,
  order,
  baseName,
  children,
}: TableBarProps) {
  const exportCsv = () => {
    const csv = toCsv(
      header,
      order.map((index) => rows[index] ?? []),
    );
    downloadText(`${baseName}.csv`, csv);
  };
  return (
    <div className="data-table-bar">
      <input
        type="search"
        className="data-table-filter"
        placeholder="Filter rows"
        aria-label="Filter rows"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <span className="data-table-count">
        {shown === total ? `${total} rows` : `${shown} of ${total} rows`}
      </span>
      <span className="spacer" />
      <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv}>
        Export CSV
      </button>
      {children}
    </div>
  );
}
