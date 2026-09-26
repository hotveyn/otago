import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { moveActive } from '../../lib/listbox';
import type { ThemeId, ThemePref } from '../../lib/theme';
import { useTheme } from '../../lib/use-theme';

const OPTIONS = [
  { id: 'auto', short: 'theme.auto', label: 'theme.autoTitle' },
  { id: 'standard', short: 'theme.standard', label: 'theme.standard' },
  { id: 'dark', short: 'theme.dark', label: 'theme.dark' },
  { id: 'cool', short: 'theme.cool', label: 'theme.coolTitle' },
] as const satisfies ReadonlyArray<{ id: ThemePref; short: string; label: string }>;

/**
 * Theme picker: a button that opens a listbox of themes. The active option (under the mouse or
 * moved to with the arrows) is previewed on the whole app; Enter or a click keeps it, Escape,
 * Tab or clicking away goes back to the saved theme.
 */
export function ThemeSwitcher() {
  const { t } = useTranslation('sidebar');
  const { pref, setPref, setPreview } = useTheme();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = Math.max(
    0,
    OPTIONS.findIndex((opt) => opt.id === pref),
  );
  const current = OPTIONS[selected] ?? OPTIONS[0];

  useEffect(() => {
    setPreview(open ? (OPTIONS[active]?.id ?? null) : null);
  }, [open, active, setPreview]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const choose = (index: number) => {
    const opt = OPTIONS[index];
    if (opt) setPref(opt.id);
    close();
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(selected);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = moveActive(active, event.key, OPTIONS.length);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="theme-picker">
      <span id={`${id}-label`} className="theme-picker-legend">
        {t('theme.legend')}
      </span>
      <div className="theme-picker-field">
        <button
          ref={buttonRef}
          type="button"
          id={`${id}-button`}
          className="theme-picker-button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          aria-labelledby={`${id}-label ${id}-button`}
          onClick={() => (open ? close() : openAt(selected))}
          onKeyDown={onButtonKeyDown}
        >
          <ThemeSwatch pref={current.id} />
          <span className="theme-picker-name">{t(current.short)}</span>
          <svg className="theme-picker-chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M3 7.5 6 4.5l3 3"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {open && (
          <div className="theme-picker-popover">
            <div
              ref={listRef}
              id={`${id}-list`}
              role="listbox"
              tabIndex={-1}
              className="theme-picker-list"
              aria-labelledby={`${id}-label`}
              aria-activedescendant={`${id}-opt-${active}`}
              onKeyDown={onListKeyDown}
              onMouseLeave={() => setActive(selected)}
              onBlur={(event) => {
                if (!rootRef.current?.contains(event.relatedTarget)) setOpen(false);
              }}
            >
              {OPTIONS.map((opt, index) => (
                // Keys are handled on the listbox (aria-activedescendant); options never take focus.
                // biome-ignore lint/a11y/useKeyWithClickEvents: see above
                <div
                  key={opt.id}
                  id={`${id}-opt-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selected}
                  data-active={index === active || undefined}
                  className="theme-picker-option"
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <ThemeSwatch pref={opt.id} />
                  <span className="theme-picker-name">{t(opt.label)}</span>
                  {index === selected && (
                    <svg className="theme-picker-check" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="m2.5 6.5 2.3 2.3 4.7-5"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
              ))}
            </div>
            <p className="theme-picker-hint" aria-hidden="true">
              {t('theme.hint')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** A tiny window drawn with the theme's own tokens; Auto is split between Standard and Dark. */
function ThemeSwatch({ pref }: { pref: ThemePref }) {
  if (pref !== 'auto') return <SwatchFace theme={pref} />;
  return (
    <span className="theme-swatch-auto" aria-hidden="true">
      <SwatchFace theme="standard" />
      <SwatchFace theme="dark" />
    </span>
  );
}

function SwatchFace({ theme }: { theme: ThemeId }) {
  return (
    <span className="theme-swatch" data-theme={theme} aria-hidden="true">
      <span className="theme-swatch-side" />
      <span className="theme-swatch-main">
        <span className="theme-swatch-line" />
        <span className="theme-swatch-line theme-swatch-accent" />
      </span>
      <span className="theme-swatch-dot" />
    </span>
  );
}
