# Plan: ui-themes / web

Project: `web` (React 19 + Vite + TypeScript, biome, vitest). Standalone, so there's no contract.
Only `web/` changes. No server work, no new dependencies.

## 1. Approach

- **Tokens only.** Every color becomes a CSS custom property. Each theme is one block that sets
  every color token, selected by `:root[data-theme="<id>"]`. Components and stylesheets use
  only `var(--token)`.
- `data-theme` on `<html>` always holds the **resolved** theme (`standard` | `dark` | `cool`),
  never `auto`. The user's preference (`auto` | `standard` | `dark` | `cool`) lives in
  `localStorage` under `otago.theme`, following the existing `otago.models` naming.
- **No flash:** a tiny inline classic `<script>` in `web/index.html` `<head>` runs before paint. It
  reads the stored preference, resolves `auto` with `matchMedia('(prefers-color-scheme: dark)')`,
  and sets `document.documentElement.dataset.theme`. If JS or storage fails, the CSS falls back
  to Standard (`:root` without an attribute gets Standard tokens).
- At runtime, React (`useTheme` hook) owns the preference. It writes storage, sets `data-theme`,
  listens to the `matchMedia` `change` event only while the preference is `auto`, and listens to
  the `storage` event so other tabs stay in sync (the nice-to-have from the feature doc; it costs
  about 5 lines).
- `color-scheme` is set inside each theme block (`light` / `dark` / `light`) so native scrollbars,
  inputs, and `<select>` render correctly.
- **xyflow:** the app imports only `@xyflow/react/dist/base.css`, and `graph.css` already
  overrides edges, controls, and attribution with our tokens. The selection rectangle,
  connection line, and minimap aren't used (`selectionKeyCode={null}`,
  `nodesConnectable={false}`, no `<MiniMap>`). So xyflow needs no `colorMode` prop. Theming it
  means tokenizing the dot grid and the node rings/shadows in `graph.css`. The `.react-flow`
  element's own background is already `var(--bg)`.
- **highlight.js:** the app doesn't import an hljs theme stylesheet. The `.hljs-*` rules in
  `markdown.css` are ours. They switch to `--hl-*` tokens.

## 2. Decisions on the open questions

### 2.1 Switcher control: segmented radio group (recommended)

- The control is a `<fieldset>` with 4 visually-hidden native `<input type="radio" name="theme">`
  elements, each with a styled `<label>`. It gives one-click switching, the current choice is
  always visible, and keyboard/screen-reader support comes free from native radios (arrow keys
  move within the group).
- Labels: `Auto`, `Standard`, `Dark`, `Cool`. The full name goes in `title` and
  `aria-label` ("Cool light"; for Auto: "Auto (follow system)"). A visually hidden `<legend>`
  reads "Theme". Four short labels at 12.5px fit the 232px inner sidebar width.
- Why not `<select>`: it hides the state behind a click and looks alien in the serif UI. It
  stays a fallback if the labels don't fit at some point.

### 2.2 Palettes (full token list)

The new tokens replace every hardcoded color found in `base.css`, `markdown.css`, and `graph.css`.
Standard values are exactly today's literals, so Standard stays pixel-identical.
Non-color tokens (`--radius`, `--serif`, `--mono`) stay in a plain `:root` block and aren't
repeated per theme.

| Token | Replaces (file:line today) | Standard | Dark | Cool light |
|---|---|---|---|---|
| `--bg` | existing | `#fbfaf6` | `#1b1a18` | `#f6f8fb` |
| `--surface` | existing | `#ffffff` | `#242320` | `#ffffff` |
| `--panel` | existing | `#f5f3ec` | `#171614` | `#edf1f6` |
| `--line` | existing | `#e4e0d5` | `#34322d` | `#dde3eb` |
| `--line-strong` | existing | `#cfc9ba` | `#4a473f` | `#c3ccd8` |
| `--text` | existing | `#22201c` | `#e8e4da` | `#1b2330` |
| `--text-soft` | existing | `#4a463e` | `#c4bfb3` | `#3b4658` |
| `--muted` | existing | `#837d70` | `#968f82` | `#5f6b7e` |
| `--accent` | existing | `#2c4f7c` | `#8fb2e0` | `#2b5797` |
| `--accent-soft` | existing | `#e8eef6` | `#1f2a3a` | `#e6eef9` |
| `--accent-line` | existing | `#9fb4d0` | `#3f5878` | `#9db5d9` |
| `--select` | existing | `#8a5a12` | `#e0b064` | `#5b3fa8` |
| `--select-soft` | existing | `#fbf1dc` | `#33291a` | `#efeafb` |
| `--danger` | existing | `#a3372b` | `#ef8a7c` | `#b3261e` |
| `--danger-soft` | existing | `#fbecea` | `#3a211d` | `#fcebea` |
| `--hit` | existing | `#fff3c4` | `#3d3418` | `#dcf1f6` |
| `--on-accent` (new) | base 292; graph 92; markdown 222, 233 (`#fff`) | `#ffffff` | `#111a26` | `#ffffff` |
| `--accent-hover` (new) | base 296-297 | `#233f64` | `#a9c4ea` | `#1f4478` |
| `--tint-1` (new) | base 212 (list hover) | `rgba(0, 0, 0, 0.035)` | `rgba(255, 255, 255, 0.04)` | `rgba(15, 30, 60, 0.035)` |
| `--tint-2` (new) | base 307 (ghost hover) | `rgba(0, 0, 0, 0.04)` | `rgba(255, 255, 255, 0.05)` | `rgba(15, 30, 60, 0.04)` |
| `--tint-3` (new) | base 338 (icon-btn hover); markdown 151 (code-copy hover) | `rgba(0, 0, 0, 0.05)` | `rgba(255, 255, 255, 0.07)` | `rgba(15, 30, 60, 0.05)` |
| `--danger-line` (new) | base 313 (btn-danger border) | `#e0b7b1` | `#6e3a33` | `#e7b8b4` |
| `--danger-note-line` (new) | base 428 | `#e6c1bb` | `#5e332d` | `#ecc5c2` |
| `--danger-ink` (new) | base 432 | `#6f2218` | `#f4b4aa` | `#7a1d17` |
| `--text-disabled` (new) | base 541 | `#b7b1a4` | `#5f5a50` | `#aab3c0` |
| `--line-no` (new) | base 861 | `#b3ad9f` | `#6a655a` | `#a4adba` |
| `--hit-bar` (new) | base 853 | `#d4a72c` | `#d4a72c` | `#3a9fb5` |
| `--hit-ink` (new) | base 866 | `#8a6d1d` | `#e0c267` | `#1f6576` |
| `--backdrop` (new) | base 474 | `rgba(34, 32, 28, 0.28)` | `rgba(0, 0, 0, 0.55)` | `rgba(20, 30, 50, 0.3)` |
| `--shadow-dialog` (new) | base 466 | `0 12px 40px rgba(34, 32, 28, 0.14)` | `0 12px 40px rgba(0, 0, 0, 0.5)` | `0 12px 40px rgba(20, 30, 50, 0.14)` |
| `--shadow-panel` (new) | base 807 | `-10px 0 30px rgba(34, 32, 28, 0.06)` | `-10px 0 30px rgba(0, 0, 0, 0.35)` | `-10px 0 30px rgba(20, 30, 50, 0.06)` |
| `--shadow-drag` (new) | graph 118 | `0 6px 18px rgba(34, 32, 28, 0.15)` | `0 6px 18px rgba(0, 0, 0, 0.5)` | `0 6px 18px rgba(20, 30, 50, 0.15)` |
| `--grid-dot` (new) | graph 8 | `#e6e2d7` | `#2e2c28` | `#dfe4ec` |
| `--select-line` (new) | graph 31 | `#e3cfa6` | `#5e4a28` | `#cfc3ee` |
| `--select-ring` (new) | graph 102 | `#f0d9a8` | `#6b5226` | `#d9cff3` |
| `--drop-ring` (new) | graph 114 | `rgba(44, 79, 124, 0.15)` | `rgba(143, 178, 224, 0.2)` | `rgba(43, 87, 151, 0.15)` |
| `--code-bg` (new) | markdown 120 | `#fcfbf8` | `#1f1e1b` | `#f9fafc` |
| `--cite-url-line` (new) | markdown 226 | `#c9c3b5` | `#4a473f` | `#c3ccd8` |
| `--hl-comment` (new) | markdown 334 | `#8f897b` | `#8f897c` | `#65707f` |
| `--hl-keyword` (new) | markdown 342 | `#7a3e9d` | `#c9a2e6` | `#6f3fb0` |
| `--hl-string` (new) | markdown 349 | `#3d7a3a` | `#9ccc8a` | `#2f7a4f` |
| `--hl-number` (new) | markdown 356 | `#b35a1f` | `#e6a06a` | `#a4511f` |
| `--hl-title` (new) | markdown 362 | `#2c4f7c` | `#8fb2e0` | `#2b5797` |
| `--hl-attr` (new) | markdown 369 | `#8a5a12` | `#e0b064` | `#0f6e7a` |
| `--hl-meta` (new) | markdown 375 | `#6b6558` | `#a8a295` | `#5d687a` |
| `color-scheme` | base 21 | `light` | `dark` | `light` |

Inline code (`.md :not(pre) > code`) already uses `var(--panel)`, so it needs no new token.
The only `rgba` in markdown.css (line 151, `.code-copy:hover`) maps to `--tint-3`.

**Swatch intent**
- *Dark:* warm charcoal, the sibling of Standard's warm paper. The sidebar (`--panel`) is the
  darkest surface, cards (`--surface`) are the lightest, and the main area (`--bg`) sits between.
  The accent becomes a light desaturated blue, so `.btn-primary` and `.box-current` use dark
  text (`--on-accent: #111a26`). Selection keeps its amber identity (`#e0b064`) and search hits
  a dim gold.
- *Cool light:* blue-white backgrounds, slate text, a slightly brighter blue accent. Select moves
  from amber to **violet** (`#5b3fa8`), so it stays distinct from the blue accent/current state.
  Hit highlights move from yellow to **pale cyan** (`#dcf1f6`) with a teal bar. There's no
  amber/yellow anywhere in the chrome. The hljs number color stays warm because it's syntax,
  not chrome.

**WCAG AA check** (computed with the WCAG relative-luminance formula; normal text needs 4.5 or more)

| Pair | Standard | Dark | Cool |
|---|---|---|---|
| text / bg, surface, panel | 15.6 / 16.3 / 14.7 | 13.7 / 12.4 / 14.2 | 14.8 / 15.8 / 13.9 |
| text-soft / bg | 9.0 | 9.5 | 9.0 |
| muted / bg, surface, panel | 3.9 / 4.1 / 3.7 (pre-existing) | 5.4 / 4.9 / 5.6 | 5.1 / 5.2 / 4.8 |
| accent / bg | 8.0 | 8.0 | 6.8 |
| on-accent / accent | 8.3 | 8.0 | 7.2 |
| accent / accent-soft | 7.2 | 6.6 | 6.2 |
| select / select-soft | 5.3 | 7.2 | 6.6 |
| danger / surface | 6.7 | 6.4 | 6.5 |
| danger-ink / danger-soft | 9.5 | 8.5 | 9.0 |
| hit-ink / hit | 4.4 (pre-existing) | 7.1 | 5.6 |
| hljs (min over tokens) / code-bg | 3.4 comment (pre-existing) | 4.8 | 4.8 |

Standard's `--muted`, `--hit-ink`, and hljs comment fall below 4.5 today. The pixel-identical
constraint wins, so they stay as-is. Flag this for the developer, but it's out of scope. The
new themes pass AA for all text pairs.

## 3. Files

### Create
1. `web/src/styles/themes.css` holds all theme token blocks:
   - `:root { --radius; --serif; --mono; }` (non-color, moved from base.css)
   - `:root, :root[data-theme="standard"] { …all color tokens…; color-scheme: light; }`
   - `:root[data-theme="dark"] { …; color-scheme: dark; }`
   - `:root[data-theme="cool"] { …; color-scheme: light; }`
   - A header comment: "Adding a theme = add one block here with every token + its id in
     `THEMES` in `src/lib/theme.ts` + in the inline script in `index.html`."
2. `web/src/lib/theme.ts` (pure, no React):
   - `export const THEMES = [{ id: 'standard', label: 'Standard', title: 'Standard' }, { id: 'dark', … }, { id: 'cool', label: 'Cool', title: 'Cool light' }] as const`
   - `export type ThemeId = (typeof THEMES)[number]['id']`, `export type ThemePref = 'auto' | ThemeId`
   - `export const THEME_STORAGE_KEY = 'otago.theme'`
   - `export const DARK_QUERY = '(prefers-color-scheme: dark)'`
   - `parseThemePref(raw: string | null): ThemePref` returns `auto` for null or unknown values.
   - `resolveTheme(pref: ThemePref, systemDark: boolean): ThemeId`: auto maps to dark when
     the system is dark, otherwise standard.
   - `applyTheme(id: ThemeId, root: HTMLElement = document.documentElement): void` sets
     `root.dataset.theme`.
3. `web/src/lib/use-theme.ts` is the React hook `useTheme(): { pref, setPref }`:
   - initial `pref = parseThemePref(safeStorage.get(THEME_STORAGE_KEY))`
   - `setPref(p)`: state update, then `safeStorage.set(key, p === 'auto' ? null : p)`. Removing
     the key for auto keeps "no preference" and "auto" identical.
   - effect on `[pref]`: `applyTheme(resolveTheme(pref, mql.matches))`. When `pref === 'auto'`,
     it subscribes `mql.addEventListener('change', …)` and cleans up.
   - effect: a `window` `storage` listener for `THEME_STORAGE_KEY` that sets the pref to
     `parseThemePref(e.newValue)` (cross-tab sync).
   - Guard `window.matchMedia` being absent (`systemDark = false`).
4. `web/src/components/sidebar/ThemeSwitcher.tsx` renders the segmented radio group (section 2.1)
   and calls `useTheme()`. Options come from `[{ id: 'auto', label: 'Auto', title: 'Auto (follow system)' }, ...THEMES]`.
5. `web/src/lib/theme.test.ts` contains the unit tests (see section 6).

### Change
6. `web/index.html`: add the inline script as the first child of `<head>`, before the icon
   link. It's a classic script, not a module, and it's wrapped in try/catch:
   ```html
   <script>
     (function () {
       var p = null;
       try { p = localStorage.getItem('otago.theme'); } catch (e) {}
       var ok = p === 'standard' || p === 'dark' || p === 'cool';
       var dark = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
       document.documentElement.dataset.theme = ok ? p : dark ? 'dark' : 'standard';
     })();
   </script>
   ```
   It must stay in sync with `theme.ts`. The test in section 6 enforces that.
7. `web/src/main.tsx`: import `./styles/themes.css` right before `./styles/base.css`.
8. `web/src/styles/base.css`:
   - Remove the `:root { … }` token block (lines 1-22). Tokens now live in themes.css.
   - Replace the literals: 212 → `var(--tint-1)`, 292 → `var(--on-accent)`, 296-297 →
     `var(--accent-hover)`, 307 → `var(--tint-2)`, 313 → `var(--danger-line)`, 338 →
     `var(--tint-3)`, 428 → `var(--danger-note-line)`, 432 → `var(--danger-ink)`, 466 →
     `var(--shadow-dialog)`, 474 → `var(--backdrop)`, 541 → `var(--text-disabled)`, 807 →
     `var(--shadow-panel)`, 853 → `inset 3px 0 0 var(--hit-bar)`, 861 → `var(--line-no)`,
     866 → `var(--hit-ink)`.
   - Add the styles for `.sidebar-footer` and `.theme-switch` (see step 5).
9. `web/src/styles/markdown.css`: 120 → `var(--code-bg)`, 151 → `var(--tint-3)`, 222/233 → `var(--on-accent)`,
   226 → `var(--cite-url-line)`, and hljs 334-375 → `var(--hl-*)`.
10. `web/src/styles/graph.css`: 8 → `radial-gradient(circle, var(--grid-dot) 1px, transparent 1.2px)`,
    31 → `var(--select-line)`, 92 → `var(--on-accent)`, 102 → `0 0 0 2px var(--select-ring)`,
    114 → `0 0 0 3px var(--drop-ring)`, 118 → `var(--shadow-drag)`.
11. `web/src/components/sidebar/Sidebar.tsx`: add `<div className="sidebar-footer"><ThemeSwitcher /></div>`
    as the last child of `<aside>`.

There are no data-model or API/interface changes. The only new persistent state is the
`localStorage` key `otago.theme` (values `standard` | `dark` | `cool`, absent means auto).

## 4. Step ordering

1. **Token extraction (Standard only).** Create `themes.css` with the plain `:root` block and the
   Standard block (existing tokens plus all new tokens at today's values). Import it in
   `main.tsx`. Remove the tokens from `base.css`. Replace every literal in `base.css`,
   `markdown.css`, and `graph.css` with tokens. Checkpoint: the app looks identical, and
   `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' web/src/styles/{base,markdown,graph}.css` returns
   nothing.
2. **Theme logic.** Create `lib/theme.ts` and `lib/theme.test.ts`, then run the tests.
3. **Dark and Cool light blocks.** Add both blocks to `themes.css` with the palettes from
   section 2.2. Check them by setting `data-theme` in devtools.
4. **Flash prevention.** Add the inline script to `index.html` and the index.html sync test.
5. **Switcher UI.** Create `use-theme.ts` and `ThemeSwitcher.tsx`, wire them into
   `Sidebar.tsx`, and add the CSS:
   - `.sidebar-footer { margin-top: auto; position: sticky; bottom: -32px; padding: 12px 0 32px; background: var(--panel); border-top: 1px solid var(--line); }`.
     This pins the footer to the bottom of the scrolling sidebar and offsets its 32px bottom
     padding. Adjust if visual QA shows otherwise.
   - `.theme-switch` is a flex row, 1px `--line-strong` border, `--radius`, `--surface`
     background.
   - Labels are 12.5px, `--text-soft`. Hover uses `--tint-2`.
   - The checked label (`input:checked + label`) uses `--accent-soft` background and
     `--accent` text.
   - `input:focus-visible + label` gets an outline in `--accent`.
   - Visually-hidden inputs use the standard clip pattern, not `display: none`, so keyboard
     focus still works.
6. **Formatting and verification** (section 7), plus manual QA of every surface in all 3 themes.

## 5. Future-theme seam

A new theme needs one block in `themes.css`, one entry in `THEMES`, and its id added to the
`ok` check in `index.html`. No component or stylesheet rule changes. The token-completeness
test fails if the new block misses a token.

## 6. Test plan

**Unit (vitest, node env, no new deps):** `web/src/lib/theme.test.ts`
- `parseThemePref`: `null` → `auto`; `'standard'|'dark'|'cool'|'auto'` → itself;
  `'solarized'`, `''`, `'DARK'` → `auto`.
- `resolveTheme`: `auto` with systemDark false → `standard`; `auto` with true → `dark`;
  explicit ids ignore systemDark (all 3 ids × both booleans).
- `applyTheme` with a stub `{ dataset: {} }` sets `dataset.theme`.
- **index.html sync:** `import html from '../../index.html?raw'`. Assert it contains
  `THEME_STORAGE_KEY` and `'<id>'` for every `THEMES` id, and the `DARK_QUERY` string.
- **Token completeness:** `import css from '../styles/themes.css?raw'`. Extract the
  custom-property names from each `[data-theme="…"]` block and the Standard block. Assert that
  every block declares the same set, that each block sets `color-scheme`, and that the set of
  block ids equals the `THEMES` ids. (`?raw` is typed by `vite/client`, already in tsconfig
  `types`.)

**Manual QA** (`pnpm --filter @otago/web dev`):
- Standard: side-by-side screenshot comparison against the pre-change build (layout, sidebar
  hover/active, buttons incl. primary hover and danger, dialog and backdrop, error note, chat
  markdown with code blocks and cite chips, graph with current/chain/selected/drop/dragging
  nodes, source viewer with hit lines). They must be pixel-identical.
- Dark and Cool light: the same walkthrough. Also check native scrollbars, `.model-pick select`,
  and text inputs render dark in Dark (color-scheme).
- No-flash: set Dark, hard reload with throttled CPU. There must be no light frame.
- Auto: toggle OS appearance (or the devtools "emulate prefers-color-scheme"). The UI follows
  live. After picking Dark explicitly, OS toggles are ignored.
- Storage: set `localStorage['otago.theme']='bogus'` and reload, which gives Auto. Blocked
  storage (devtools or a private window) still allows switching for the session.
- Two tabs: switching in one updates the other.
- Keyboard: Tab into the switcher, arrow keys change the theme, and the focus ring is visible.

## 7. Verification commands

```sh
pnpm --filter @otago/web format   # biome format --write (do not hand-format)
pnpm --filter @otago/web lint     # biome check + tsc --noEmit
pnpm --filter @otago/web test     # vitest run
pnpm --filter @otago/web build    # tsc + vite build; confirm dist/index.html keeps the inline script
```

## 8. Effort

About 0.5-1 dev-day. Token extraction plus the three theme blocks take about 3h. Logic, hook,
switcher, and tests take about 2h. Visual QA of 3 themes × all surfaces takes about 1-2h.
