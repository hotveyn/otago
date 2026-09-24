/** Theme ids, preference parsing and resolution. Pure: no React. */

export const THEMES = [
  { id: 'standard', label: 'Standard', title: 'Standard' },
  { id: 'dark', label: 'Dark', title: 'Dark' },
  { id: 'cool', label: 'Cool', title: 'Cool light' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export type ThemePref = 'auto' | ThemeId;

/** Kept in sync with the inline script in `index.html` (enforced by theme.test.ts). */
export const THEME_STORAGE_KEY = 'otago.theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

function isThemeId(value: string): value is ThemeId {
  return THEME_IDS.includes(value);
}

/** Stored value -> preference. Missing or unknown values mean `auto`. */
export function parseThemePref(raw: string | null): ThemePref {
  if (raw === null) return 'auto';
  return isThemeId(raw) ? raw : 'auto';
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ThemeId {
  if (pref !== 'auto') return pref;
  return systemDark ? 'dark' : 'standard';
}

export function applyTheme(
  id: ThemeId,
  root: Pick<HTMLElement, 'dataset'> = document.documentElement,
): void {
  root.dataset.theme = id;
}
