import { Trans, useTranslation } from 'react-i18next';
import type { Suggestion } from '../../api/types';
import { suggestionLabel, suggestionSource } from '../../lib/suggestions';
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
        return (
          <Button
            key={`${item.target}\0${item.text}`}
            size="sm"
            className="suggestion"
            title={
              source === null
                ? item.text
                : `${item.text}\n${t('suggestions.askUnder', { target: item.target })}`
            }
            onClick={() => onAsk(item)}
          >
            <span dir="auto">{suggestionLabel(item.text)}</span>
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
