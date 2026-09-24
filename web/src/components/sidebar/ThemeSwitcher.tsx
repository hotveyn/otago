import { THEMES, type ThemePref } from '../../lib/theme';
import { useTheme } from '../../lib/use-theme';

const OPTIONS: ReadonlyArray<{ id: ThemePref; label: string; title: string }> = [
  { id: 'auto', label: 'Auto', title: 'Auto (follow system)' },
  ...THEMES,
];

export function ThemeSwitcher() {
  const { pref, setPref } = useTheme();
  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">Theme</legend>
      {OPTIONS.map((opt) => {
        const inputId = `theme-${opt.id}`;
        return (
          <span key={opt.id} className="theme-switch-option">
            <input
              type="radio"
              id={inputId}
              name="theme"
              value={opt.id}
              className="visually-hidden"
              checked={pref === opt.id}
              onChange={() => setPref(opt.id)}
              aria-label={opt.title}
            />
            <label htmlFor={inputId} title={opt.title}>
              {opt.label}
            </label>
          </span>
        );
      })}
    </fieldset>
  );
}
