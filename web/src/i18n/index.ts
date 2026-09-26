import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { safeStorage } from '../lib/storage';
import { LANGUAGE_STORAGE_KEY, type Language, resolveLanguage } from './language';
import { en } from './locales/en';
import { ru } from './locales/ru';

export const resources = { en, ru } as const;

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function applyLanguage(lng: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(safeStorage.get(LANGUAGE_STORAGE_KEY), browserLanguages()),
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(en),
  // React escapes rendered text itself.
  interpolation: { escapeValue: false },
});

applyLanguage(i18n.language);
i18n.on('languageChanged', applyLanguage);

// Cross-tab sync: another tab changed the language.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null)
      void i18n.changeLanguage(
        resolveLanguage(event.key === null ? null : event.newValue, browserLanguages()),
      );
  });

export function setLanguage(lng: Language): void {
  safeStorage.set(LANGUAGE_STORAGE_KEY, lng);
  void i18n.changeLanguage(lng);
}

export { i18n };
