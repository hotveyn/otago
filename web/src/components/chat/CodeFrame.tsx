import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function CopyButton({ text }: { text: () => string }) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied; nothing to do.
    }
  };
  return (
    <button type="button" className="code-copy" onClick={copy}>
      {copied ? t('code.copied') : t('code.copy')}
    </button>
  );
}

interface CodeFrameProps {
  label: string;
  /** Header buttons before Copy. */
  actions?: ReactNode;
  copyText: () => string;
  className?: string;
  children: ReactNode;
}

/** The `.code-block` chrome: language label, actions, Copy, body. */
export function CodeFrame({ label, actions, copyText, className, children }: CodeFrameProps) {
  return (
    <div className={className ? `code-block ${className}` : 'code-block'}>
      <div className="code-header">
        <span className="code-lang">{label}</span>
        <span className="code-actions">
          {actions}
          <CopyButton text={copyText} />
        </span>
      </div>
      {children}
    </div>
  );
}

/** Toggle between the rendered view and the source. */
export function ViewToggle({
  labels,
  source,
  onChange,
}: {
  labels: [string, string];
  source: boolean;
  onChange: (source: boolean) => void;
}) {
  return (
    <span className="view-toggle">
      <button
        type="button"
        className="code-copy"
        aria-pressed={!source}
        onClick={() => onChange(false)}
      >
        {labels[0]}
      </button>
      <button
        type="button"
        className="code-copy"
        aria-pressed={source}
        onClick={() => onChange(true)}
      >
        {labels[1]}
      </button>
    </span>
  );
}

export function SourcePre({ source }: { source: string }) {
  return (
    <pre>
      <code>{source}</code>
    </pre>
  );
}
