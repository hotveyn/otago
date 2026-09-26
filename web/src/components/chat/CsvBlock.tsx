import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseCsv } from '../../lib/csv';
import { CodeFrame, SourcePre, ViewToggle } from './CodeFrame';
import { DataTable } from './DataTable';

interface CsvBlockProps {
  source: string;
  delimiter: ',' | '\t';
  /** The fence is complete; while streaming an unclosed block shows its source only. */
  closed: boolean;
}

/** ```csv / ```tsv fenced block rendered as a sortable, filterable table. */
export function CsvBlock({ source, delimiter, closed }: CsvBlockProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [showSource, setShowSource] = useState(false);
  const parsed = useMemo(
    () => (closed ? parseCsv(source, delimiter) : null),
    [closed, source, delimiter],
  );
  const label = delimiter === '\t' ? 'tsv' : 'csv';
  const copyText = () => source;

  if (!closed || !parsed) {
    return (
      <CodeFrame label={label} copyText={copyText}>
        <SourcePre source={source} />
        <p className="code-note muted">{closed ? t('code.csvError') : t('code.tablePending')}</p>
      </CodeFrame>
    );
  }

  return (
    <CodeFrame
      label={label}
      copyText={copyText}
      className="csv-block"
      actions={
        <ViewToggle
          labels={[t('code.table'), t('common:source')]}
          source={showSource}
          onChange={setShowSource}
        />
      }
    >
      {showSource ? (
        <SourcePre source={source} />
      ) : (
        <DataTable header={parsed.header} rows={parsed.rows} baseName="table" />
      )}
    </CodeFrame>
  );
}
