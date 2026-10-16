import { Trans, useTranslation } from 'react-i18next';
import type { Suggestion } from '../../api/types';
import { isWholeSuggestion, suggestionLabel, suggestionSource } from '../../lib/suggestions';
import { Button } from '../ui/Button';

interface SuggestionListProps {
  /** Already filtered (`useSuggestions`). */
  items: Suggestion[];
  onAsk: (suggestion: Suggestion) => void;
}

/** Suggested follow-up questions under the last answer of a chat panel. */
export function SuggestionList({ items, onAsk }: SuggestionListProps) {
  const { t } = useTranslation('chat');
  if (items.length === 0) return null;
  return (
    <nav className="suggestions" aria-label={t('suggestions.label')}>
      {items.map((item) => {
        const source = suggestionSource(item);
        const whole = isWholeSuggestion(item);
        const where =
          whole && item.target === ''
            ? t('suggestions.askAtRoot')
            : t('suggestions.askUnder', { target: item.target });
        return (
          <Button
            key={`${item.kind ?? ''}\0${item.target}\0${item.text}`}
            size="sm"
            className={whole ? 'suggestion suggestion-whole' : 'suggestion'}
            title={whole || source !== null ? `${item.text}\n${where}` : item.text}
            onClick={() => onAsk(item)}
          >
            <span dir="auto">{suggestionLabel(item.text)}</span>
            {whole && <span className="suggestion-kind">{t('suggestions.whole')}</span>}
            {source !== null && (
              <span className="suggestion-source">
                <Trans
                  t={t}
                  i18nKey="suggestions.from"
                  values={{ name: source }}
                  components={{ name: <bdi dir="auto" /> }}
                />
              </span>
            )}
          </Button>
        );
      })}
    </nav>
  );
}
