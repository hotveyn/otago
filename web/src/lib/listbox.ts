/** Keyboard navigation for a single-select listbox. Pure: no React. */

/**
 * The option index a navigation key moves to, wrapping at the ends; `null` when the key does not
 * navigate. `current` may be -1 (nothing active yet).
 */
export function moveActive(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
    case 'PageUp':
      return 0;
    case 'End':
    case 'PageDown':
      return count - 1;
    default:
      return null;
  }
}
