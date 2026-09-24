import { describe, expect, it } from 'vitest';
import { type Box, placePopup } from './popup-position';

const bounds: Box = { top: 100, left: 0, width: 800, height: 600 };
const popup = { width: 80, height: 30 };

describe('placePopup', () => {
  it('places the popup above the anchor, horizontally centred', () => {
    const anchor: Box = { top: 300, left: 200, width: 100, height: 20 };
    expect(placePopup(anchor, popup, bounds)).toEqual({
      top: 300 - 30 - 6,
      left: 250 - 40,
      placement: 'above',
    });
  });

  it('flips below when there is no room above', () => {
    const anchor: Box = { top: 110, left: 200, width: 100, height: 20 };
    expect(placePopup(anchor, popup, bounds)).toEqual({
      top: 110 + 20 + 6,
      left: 210,
      placement: 'below',
    });
  });

  it('clamps left inside the bounds near the edges', () => {
    const leftEdge: Box = { top: 300, left: 0, width: 10, height: 20 };
    expect(placePopup(leftEdge, popup, bounds).left).toBe(4);
    const rightEdge: Box = { top: 300, left: 795, width: 5, height: 20 };
    expect(placePopup(rightEdge, popup, bounds).left).toBe(800 - 80 - 4);
  });

  it('clamps top inside the bounds', () => {
    const bottom: Box = { top: 99, left: 200, width: 10, height: 700 };
    const { top } = placePopup(bottom, popup, bounds);
    expect(top).toBeLessThanOrEqual(100 + 600 - 30);
    expect(top).toBeGreaterThanOrEqual(100);
  });
});
