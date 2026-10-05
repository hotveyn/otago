import { useState, useSyncExternalStore } from 'react';
import { i18n } from '../../web/src/i18n';
import { resetDemo } from './mock/runtime';

const TEXT = {
  en: {
    label: 'Demo',
    note: 'Demo: answers are simulated, everything stays in this browser.',
    reset: 'Reset',
    confirm: 'Reset?',
    yes: 'Yes',
    no: 'No',
  },
  ru: {
    label: 'Демо',
    note: 'Демо: ответы симулируются, все данные хранятся в этом браузере.',
    reset: 'Сбросить',
    confirm: 'Сбросить?',
    yes: 'Да',
    no: 'Нет',
  },
};

const subscribe = (onChange: () => void) => {
  i18n.on('languageChanged', onChange);
  return () => i18n.off('languageChanged', onChange);
};

const useLanguage = () => useSyncExternalStore(subscribe, () => i18n.language);

/** Compact fixed badge (bottom left, under the sidebar settings) with a reset to the seed. */
export function DemoBanner() {
  const t = useLanguage().startsWith('ru') ? TEXT.ru : TEXT.en;
  const [confirming, setConfirming] = useState(false);
  return (
    <aside className="demo-banner" aria-label={t.note} title={t.note}>
      <span className="demo-banner-label">{t.label}</span>
      {confirming ? (
        <>
          <span className="demo-banner-note">{t.confirm}</span>
          <button type="button" className="btn btn-sm btn-danger" onClick={resetDemo}>
            {t.yes}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setConfirming(false)}
          >
            {t.no}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(true)}>
          {t.reset}
        </button>
      )}
    </aside>
  );
}
