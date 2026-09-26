import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { mermaidErrorMessage, peekMermaid, renderMermaid } from '../../lib/mermaid';
import { CodeFrame, SourcePre, ViewToggle } from './CodeFrame';

type RenderState =
  | { status: 'loading' }
  | { status: 'ok'; svg: string }
  | { status: 'error'; message: string };

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

const themeSnapshot = () => document.documentElement.dataset.theme ?? '';

interface MermaidBlockProps {
  source: string;
  /** The fence is complete; an unclosed streaming block is never rendered. */
  closed: boolean;
}

/** ```mermaid fenced block rendered as a diagram, with a Diagram / Source toggle. */
export function MermaidBlock({ source, closed }: MermaidBlockProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [state, setState] = useState<RenderState>(() => {
    const svg = closed ? peekMermaid(source) : undefined;
    return svg ? { status: 'ok', svg } : { status: 'loading' };
  });
  const [showSource, setShowSource] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot, () => '');

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-render the diagram on theme change
  useEffect(() => {
    if (!closed) return;
    let stale = false;
    const ready = peekMermaid(source);
    setState(ready ? { status: 'ok', svg: ready } : { status: 'loading' });
    renderMermaid(source).then(
      (svg) => {
        if (!stale) setState({ status: 'ok', svg });
      },
      (error: unknown) => {
        if (!stale) setState({ status: 'error', message: mermaidErrorMessage(error) });
      },
    );
    return () => {
      stale = true;
    };
  }, [source, closed, theme]);

  const copyText = () => source;

  if (!closed) {
    return (
      <CodeFrame label="mermaid" copyText={copyText}>
        <SourcePre source={source} />
        <p className="code-note muted">{t('code.diagramPending')}</p>
      </CodeFrame>
    );
  }

  return (
    <CodeFrame
      label="mermaid"
      copyText={copyText}
      className="mermaid-block"
      actions={
        state.status === 'ok' ? (
          <ViewToggle
            labels={[t('code.diagram'), t('common:source')]}
            source={showSource}
            onChange={setShowSource}
          />
        ) : null
      }
    >
      {state.status === 'error' ? (
        <>
          <SourcePre source={source} />
          <p className="mermaid-error">{t('code.diagramError', { message: state.message })}</p>
        </>
      ) : state.status === 'loading' ? (
        <div className="mermaid-loading muted">{t('code.diagramRendering')}</div>
      ) : showSource ? (
        <SourcePre source={source} />
      ) : (
        <div
          className="mermaid-svg"
          // Safe: mermaid's securityLevel 'strict' sanitizes the SVG and disables scripts/clicks.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized mermaid output
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
    </CodeFrame>
  );
}
