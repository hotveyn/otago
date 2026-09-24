/** Lazy, serialized Mermaid rendering. `mermaid` is loaded with a dynamic import (own chunk). */
import type { Mermaid } from 'mermaid';

let loading: Promise<Mermaid> | null = null;
let initializedFor: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

const CACHE_LIMIT = 50;
const cache = new Map<string, Promise<string>>();
/** Settled successful renders, for a synchronous first paint on remount. */
const done = new Map<string, string>();

function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((module) => module.default);
  return loading;
}

function currentTheme(): string {
  if (typeof document === 'undefined') return 'standard';
  return document.documentElement.dataset.theme ?? 'standard';
}

/** Theme variables from the app's CSS tokens, so diagrams follow the active theme. */
function themeVariables() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const surface = token('--surface', '#ffffff');
  const text = token('--text', '#22201c');
  const line = token('--line-strong', '#cfc9ba');
  const panel = token('--panel', '#f5f3ec');
  const accentSoft = token('--accent-soft', '#e8eef6');
  const accentLine = token('--accent-line', '#9fb4d0');
  return {
    darkMode: style.colorScheme === 'dark',
    background: surface,
    fontFamily: token('--serif', 'Georgia, serif'),
    primaryColor: accentSoft,
    primaryBorderColor: accentLine,
    primaryTextColor: text,
    secondaryColor: panel,
    secondaryBorderColor: line,
    secondaryTextColor: text,
    tertiaryColor: surface,
    tertiaryBorderColor: line,
    tertiaryTextColor: text,
    lineColor: token('--text-soft', '#4a463e'),
    textColor: text,
    mainBkg: accentSoft,
    nodeBorder: accentLine,
    clusterBkg: panel,
    clusterBorder: line,
    noteBkgColor: token('--select-soft', '#fbf1dc'),
    noteBorderColor: token('--select-line', '#e3cfa6'),
    noteTextColor: text,
    edgeLabelBackground: surface,
  };
}

function prepare(mermaid: Mermaid, theme: string) {
  if (initializedFor === theme) return;
  const variables = themeVariables();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: variables.fontFamily,
    themeVariables: variables,
  });
  initializedFor = theme;
}

function removeStray(id: string) {
  for (const selector of [`#d${id}`, `#${id}`, `#i${id}`])
    document.querySelector(selector)?.remove();
}

async function renderNow(source: string, theme: string): Promise<string> {
  const mermaid = await loadMermaid();
  prepare(mermaid, theme);
  counter += 1;
  const id = `otago-mermaid-${counter}`;
  try {
    await mermaid.parse(source);
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    removeStray(id);
  }
}

const keyOf = (source: string) => `${currentTheme()}\u0000${source}`;

/** The already rendered SVG for this source and theme, if any. */
export function peekMermaid(source: string): string | undefined {
  return done.get(keyOf(source));
}

/** Render Mermaid source to an SVG string. Serialized (mermaid has global state), memoized. */
export function renderMermaid(source: string): Promise<string> {
  const theme = currentTheme();
  const key = keyOf(source);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const result = queue.then(() => renderNow(source, theme));
  queue = result.catch(() => undefined);
  cache.set(key, result);
  result.then((svg) => done.set(key, svg)).catch(() => undefined);
  // Failed renders are not worth keeping: the source usually changes next.
  result.catch(() => cache.delete(key));
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    done.delete(oldest);
  }
  return result;
}

/** First line of a parser/render error, for the inline note. */
export function mermaidErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n').find((line) => line.trim() !== '') ?? 'Could not render diagram';
}
