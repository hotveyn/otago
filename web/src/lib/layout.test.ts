import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  clampChatAreaWidth,
  clampSideWidth,
  defaultChatWidth,
  defaultSideWidth,
  GRAPH_MIN_WIDTH,
  SIDE_MIN_WIDTH,
  SIDEBAR_WIDTH,
} from './layout';

describe('clampChatAreaWidth', () => {
  it('keeps widths inside the allowed range untouched', () => {
    expect(clampChatAreaWidth(600, 1600, SIDEBAR_WIDTH)).toBe(600);
  });

  it('never goes below the chat minimum', () => {
    expect(clampChatAreaWidth(100, 1600, SIDEBAR_WIDTH)).toBe(CHAT_MIN_WIDTH);
  });

  it('leaves room for the graph', () => {
    expect(clampChatAreaWidth(5000, 1600, SIDEBAR_WIDTH)).toBe(
      1600 - SIDEBAR_WIDTH - GRAPH_MIN_WIDTH,
    );
  });

  it('prefers the chat minimum on tiny viewports', () => {
    expect(clampChatAreaWidth(5000, 500, SIDEBAR_WIDTH)).toBe(CHAT_MIN_WIDTH);
  });
});

describe('defaultChatWidth', () => {
  it('is 42% of the viewport, at least 352px', () => {
    expect(defaultChatWidth(2000)).toBe(840);
    expect(defaultChatWidth(800)).toBe(352);
  });
});

describe('clampChatAreaWidth with a side chat', () => {
  it('keeps the area where it is when both chats fit', () => {
    expect(clampChatAreaWidth(900, 1600, SIDEBAR_WIDTH, true)).toBe(900);
  });

  it('grows the area only when both chats cannot fit', () => {
    expect(clampChatAreaWidth(300, 1600, SIDEBAR_WIDTH, true)).toBe(
      CHAT_MIN_WIDTH + SIDE_MIN_WIDTH,
    );
  });

  it('still leaves room for the graph', () => {
    expect(clampChatAreaWidth(5000, 1600, SIDEBAR_WIDTH, true)).toBe(
      1600 - SIDEBAR_WIDTH - GRAPH_MIN_WIDTH,
    );
  });

  it('prefers both minimums on tiny viewports', () => {
    expect(clampChatAreaWidth(5000, 500, SIDEBAR_WIDTH, true)).toBe(
      CHAT_MIN_WIDTH + SIDE_MIN_WIDTH,
    );
  });
});

describe('clampSideWidth', () => {
  it('keeps widths inside the allowed range untouched', () => {
    expect(clampSideWidth(420, 1000)).toBe(420);
  });

  it('never goes below the side minimum', () => {
    expect(clampSideWidth(50, 1000)).toBe(SIDE_MIN_WIDTH);
  });

  it('leaves the main chat its minimum inside the area', () => {
    expect(clampSideWidth(5000, 1000)).toBe(1000 - CHAT_MIN_WIDTH);
  });

  it('prefers the side minimum in a tiny area', () => {
    expect(clampSideWidth(5000, 300)).toBe(SIDE_MIN_WIDTH);
  });
});

describe('defaultSideWidth', () => {
  it('is 30% of the viewport, at least the chat minimum', () => {
    expect(defaultSideWidth(2000)).toBe(600);
    expect(defaultSideWidth(800)).toBe(CHAT_MIN_WIDTH);
  });
});
