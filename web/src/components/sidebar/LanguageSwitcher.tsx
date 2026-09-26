import { useTranslation } from 'react-i18next';
import { setLanguage } from '../../i18n';
import { LANGUAGES } from '../../i18n/language';

/** Same segmented control as the theme switcher. */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation('sidebar');
  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">{t('language.legend')}</legend>
      {LANGUAGES.map((lang) => {
        const inputId = `lang-${lang.id}`;
        return (
          <span key={lang.id} className="theme-switch-option">
            <input
              type="radio"
              id={inputId}
              name="language"
              value={lang.id}
              className="visually-hidden"
              checked={i18n.resolvedLanguage === lang.id}
              onChange={() => setLanguage(lang.id)}
              aria-label={lang.title}
            />
            <label htmlFor={inputId} title={lang.title} lang={lang.id}>
              {lang.label}
            </label>
          </span>
        );
      })}
    </fieldset>
  );
}
