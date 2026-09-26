/** Language ids, preference parsing and detection. Pure: no React, no i18next. */

export const LANGUAGES = [
  { id: 'en', label: 'EN', title: 'English' },
  { id: 'ru', label: 'RU', title: 'Русский' },
] as const;

export type Language = (typeof LANGUAGES)[number]['id'];

export const DEFAULT_LANGUAGE: Language = 'en';
export const LANGUAGE_STORAGE_KEY = 'otago.lang';

const LANGUAGE_IDS: readonly string[] = LANGUAGES.map((l) => l.id);

export function isLanguage(value: string): value is Language {
  return LANGUAGE_IDS.includes(value);
}

/** First supported language by primary subtag (`ru-RU` -> `ru`), else the default. */
export function matchLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split('-')[0] ?? '';
    if (isLanguage(primary)) return primary;
  }
  return DEFAULT_LANGUAGE;
}

/** Stored choice wins; without one, follow the browser languages. */
export function resolveLanguage(stored: string | null, preferred: readonly string[]): Language {
  if (stored !== null && isLanguage(stored)) return stored;
  return matchLanguage(preferred);
}
