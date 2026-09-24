import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import css from '../styles/themes.css?raw';
import {
  applyTheme,
  DARK_QUERY,
  parseThemePref,
  resolveTheme,
  THEME_STORAGE_KEY,
  THEMES,
  type ThemeId,
} from './theme';

const IDS: ThemeId[] = THEMES.map((t) => t.id);

describe('parseThemePref', () => {
  it('treats a missing value as auto', () => {
    expect(parseThemePref(null)).toBe('auto');
  });

  it('keeps known values', () => {
    for (const v of ['standard', 'dark', 'cool', 'auto'] as const) {
      expect(parseThemePref(v)).toBe(v);
    }
  });

  it('treats unknown or corrupt values as auto', () => {
    for (const v of ['solarized', '', 'DARK']) {
      expect(parseThemePref(v)).toBe('auto');
    }
  });
});

describe('resolveTheme', () => {
  it('follows the system in auto', () => {
    expect(resolveTheme('auto', false)).toBe('standard');
    expect(resolveTheme('auto', true)).toBe('dark');
  });

  it('ignores the system for explicit themes', () => {
    for (const id of IDS) {
      expect(resolveTheme(id, false)).toBe(id);
      expect(resolveTheme(id, true)).toBe(id);
    }
  });
});

describe('applyTheme', () => {
  it('sets data-theme on the root', () => {
    const root = { dataset: {} as DOMStringMap };
    applyTheme('cool', root);
    expect(root.dataset.theme).toBe('cool');
  });
});

describe('index.html inline script', () => {
  it('stays in sync with theme.ts', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(html).toContain(`'${DARK_QUERY}'`);
    for (const id of IDS) expect(html).toContain(`'${id}'`);
  });
});

describe('themes.css', () => {
  /** Selector -> declaration body for every top-level rule. */
  function rules(source: string): Array<{ selector: string; body: string }> {
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: (m[1] ?? '').trim(),
      body: m[2] ?? '',
    }));
  }

  function tokens(body: string): string[] {
    return [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? '').sort();
  }

  const themeBlocks = rules(css)
    .map((r) => ({ ...r, id: /\[data-theme="([^"]+)"\]/.exec(r.selector)?.[1] }))
    .filter((r): r is typeof r & { id: string } => r.id !== undefined);

  it('declares a block for exactly the THEMES ids', () => {
    expect(themeBlocks.map((b) => b.id).sort()).toEqual([...IDS].sort());
  });

  it('makes Standard the fallback for :root without data-theme', () => {
    const standard = themeBlocks.find((b) => b.id === 'standard');
    expect(standard?.selector.split(',').map((s) => s.trim())).toContain(':root');
  });

  it('declares the same tokens and color-scheme in every theme', () => {
    const standard = themeBlocks.find((b) => b.id === 'standard');
    const expected = tokens(standard?.body ?? '');
    expect(expected.length).toBeGreaterThan(0);
    for (const block of themeBlocks) {
      expect(tokens(block.body), block.id).toEqual(expected);
      expect(block.body, block.id).toMatch(/color-scheme\s*:\s*(light|dark)\s*;/);
    }
  });
});
