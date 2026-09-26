import { useCallback, useEffect, useState } from 'react';
import { safeStorage } from './storage';
import {
  applyTheme,
  DARK_QUERY,
  parseThemePref,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePref,
} from './theme';

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
}

/**
 * The user's theme preference; keeps `data-theme` on <html> and storage in sync. `setPreview`
 * shows another theme without saving it (`null` goes back to the preference).
 */
export function useTheme(): {
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
  setPreview: (pref: ThemePref | null) => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(() =>
    parseThemePref(safeStorage.get(THEME_STORAGE_KEY)),
  );
  const [preview, setPreview] = useState<ThemePref | null>(null);
  const shown = preview ?? pref;

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    setPreview(null);
    // No key means auto, so "no preference" and "auto" stay identical.
    safeStorage.set(THEME_STORAGE_KEY, next === 'auto' ? null : next);
  }, []);

  useEffect(() => {
    const mql = darkQuery();
    applyTheme(resolveTheme(shown, mql?.matches ?? false));
    if (shown !== 'auto' || !mql) return;
    const onChange = (e: MediaQueryListEvent) => applyTheme(resolveTheme('auto', e.matches));
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [shown]);

  // Cross-tab sync: another tab changed the preference.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY || e.key === null) {
        setPrefState(parseThemePref(e.key === null ? null : e.newValue));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { pref, setPref, setPreview };
}
