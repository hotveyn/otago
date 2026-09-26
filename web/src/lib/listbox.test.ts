import { describe, expect, it } from 'vitest';
import { moveActive } from './listbox';

describe('moveActive', () => {
  it('steps with the arrows and wraps at the ends', () => {
    expect(moveActive(1, 'ArrowDown', 4)).toBe(2);
    expect(moveActive(3, 'ArrowDown', 4)).toBe(0);
    expect(moveActive(1, 'ArrowUp', 4)).toBe(0);
    expect(moveActive(0, 'ArrowUp', 4)).toBe(3);
  });

  it('starts from the matching end when nothing is active', () => {
    expect(moveActive(-1, 'ArrowDown', 4)).toBe(0);
    expect(moveActive(-1, 'ArrowUp', 4)).toBe(3);
  });

  it('jumps to the first and last option', () => {
    expect(moveActive(2, 'Home', 4)).toBe(0);
    expect(moveActive(2, 'PageUp', 4)).toBe(0);
    expect(moveActive(1, 'End', 4)).toBe(3);
    expect(moveActive(1, 'PageDown', 4)).toBe(3);
  });

  it('ignores other keys and empty lists', () => {
    expect(moveActive(1, 'Enter', 4)).toBeNull();
    expect(moveActive(1, 'a', 4)).toBeNull();
    expect(moveActive(0, 'ArrowDown', 0)).toBeNull();
  });
});
