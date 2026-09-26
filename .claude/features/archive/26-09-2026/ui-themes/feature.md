# UI color themes (Standard, Dark, Cool light)

## Summary
Add theme support to the Otago web UI. The user picks one of: **Auto** (follow OS), **Standard** (the current warm-paper look), **Dark**, and **Cool light** (a light theme in cool blue/grey tones instead of the current warm/yellow ones). The choice persists per browser.

## Goals
- Three visual themes: Standard (current palette, unchanged), Dark, Cool light.
- An **Auto** mode, which is the default: OS light → Standard, OS dark → Dark. Reacts live to OS changes.
- Theme switcher in the sidebar footer, always visible.
- Choice persisted in `localStorage` (via existing `web/src/lib/storage.ts` `safeStorage`).
- Every UI surface themed: layout, sidebar, chat, markdown (incl. code highlighting), graph (xyflow canvas, dots, nodes, selection, shadows), dialogs, buttons, error notes, source viewer.
- No flash of the wrong theme on page load.

## Non-goals
- Server changes / syncing the theme via `trees/`.
- Per-tree themes, custom accent colors, user-defined themes.
- Changing typography, layout, or spacing.
- Redesigning the Standard theme.

## Actors
- **User** — the single local user of the app.

## Main scenarios
1. **First launch:** no stored preference → Auto → theme follows OS.
2. **Pick a theme:** user selects Standard / Dark / Cool light / Auto in the sidebar footer → UI switches instantly, no reload; choice saved.
3. **Reload:** stored theme is applied before first paint.
4. **OS switches light↔dark while in Auto:** UI follows immediately.

## Edge cases
- `localStorage` unavailable (private mode, blocked) → fall back to Auto; switching still works for the session (safeStorage already swallows errors).
- Stored value unknown/corrupt (e.g. removed theme) → treat as Auto.
- Explicit theme chosen → OS changes are ignored.
- Hardcoded colors currently outside tokens must become tokens: `markdown.css` (code block bg, inline code bg, hljs syntax colors, button `#fff`, borders) and `graph.css` (dot-grid background, node borders, selection rings, shadows with baked-in rgba).
- Third-party visuals: xyflow controls/minimap/edges and highlight.js must match each theme.
- `color-scheme` must match the active theme so native controls (scrollbars, inputs, selects) render correctly in Dark.
- Multiple open tabs: changing the theme in one tab should ideally update others (`storage` event) — nice to have, not required.

## Constraints (NFR)
- Contrast: body text and interactive elements meet WCAG AA in all themes.
- Adding a future theme must only require a new token block, no component changes (tokens-only approach).
- No new runtime dependencies.
- Standard theme must look pixel-identical to today.

## Future considerations (out of scope)
- None specified by the user.

## Open questions
- Exact Cool light palette (proposed: cool grey/blue-white backgrounds, slate text, blue accent; the "select"/"hit" highlight colors move away from amber/yellow). To be proposed in plan with swatches.
- Switcher control style: native `<select>` vs segmented control — decide in plan.
