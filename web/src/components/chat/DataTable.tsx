import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PREVIEW_LIMITS } from '../../lib/attachments';
import { SortButton, TableBar, useTableView } from './table-controls';

interface DataTableProps {
  header: string[];
  rows: string[][];
  /** Export file name without extension. */
  baseName: string;
  /** Show only this many rows until "Show all" is clicked. */
  collapsedRows?: number;
  /** Full file URL for the "Download full file" link when rows were cut at the limit. */
  fullFileUrl?: string;
  /** Extra buttons in the bar (e.g. Download). */
  extraActions?: ReactNode;
}

/** Sortable, filterable table over parsed CSV/TSV rows, capped at PREVIEW_LIMITS.tableRows. */
export function DataTable({
  header,
  rows,
  baseName,
  collapsedRows,
  fullFileUrl,
  extraActions,
}: DataTableProps) {
  const { t } = useTranslation('chat');
  const limited = useMemo(() => rows.slice(0, PREVIEW_LIMITS.tableRows), [rows]);
  const truncatedFrom = rows.length > limited.length ? rows.length : null;
  const { order, query, setQuery, cycle, ariaSort } = useTableView(limited);
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsedRows !== undefined && !expanded && order.length > collapsedRows;
  const visible = collapsed ? order.slice(0, collapsedRows) : order;

  return (
    <div className="data-table">
      <TableBar
        query={query}
        onQuery={setQuery}
        shown={order.length}
        total={limited.length}
        header={header}
        rows={limited}
        order={order}
        baseName={baseName}
      >
        {extraActions}
      </TableBar>
      <div className="table-wrap data-table-scroll">
        <table>
          <thead>
            <tr>
              {header.map((label, column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <th key={column} aria-sort={ariaSort(column)}>
                  <SortButton label={label} sort={ariaSort(column)} onClick={() => cycle(column)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((index) => (
              <tr key={index}>
                {(limited[index] ?? []).map((cell, column) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(collapsed || truncatedFrom !== null) && (
        <div className="data-table-foot muted small">
          {collapsed && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setExpanded(true)}
            >
              {t('table.showAll', { count: order.length })}
            </button>
          )}
          {truncatedFrom !== null && (
            <span>
              {t('table.firstRows', { shown: limited.length, count: truncatedFrom })}
              {fullFileUrl && (
                <>
                  {' · '}
                  <a href={fullFileUrl} download>
                    {t('table.downloadFull')}
                  </a>
                </>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
