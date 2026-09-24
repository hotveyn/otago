export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PopupPlacement {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

const EDGE = 4;

/**
 * Place a popup above the anchor (horizontally centred), flipping below when there is no room
 * above, and clamp it inside the bounds.
 */
export function placePopup(
  anchor: Box,
  popup: { width: number; height: number },
  bounds: Box,
  gap = 6,
): PopupPlacement {
  let placement: PopupPlacement['placement'] = 'above';
  let top = anchor.top - popup.height - gap;
  if (top < bounds.top) {
    placement = 'below';
    top = anchor.top + anchor.height + gap;
  }
  const minTop = bounds.top;
  const maxTop = Math.max(minTop, bounds.top + bounds.height - popup.height);
  top = Math.min(Math.max(top, minTop), maxTop);

  const minLeft = bounds.left + EDGE;
  const maxLeft = Math.max(minLeft, bounds.left + bounds.width - popup.width - EDGE);
  const centred = anchor.left + anchor.width / 2 - popup.width / 2;
  const left = Math.min(Math.max(centred, minLeft), maxLeft);

  return { top, left, placement };
}
