import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  clampChatWidth,
  clampSideWidth,
  defaultChatWidth,
  defaultSideWidth,
  GRAPH_MIN_WIDTH,
  SIDE_MIN_WIDTH,
  SIDEBAR_WIDTH,
} from './layout';

describe('clampChatWidth', () => {
  it('keeps widths inside the allowed range untouched', () => {
    expect(clampChatWidth(600, 1600, SIDEBAR_WIDTH)).toBe(600);
  });

  it('never goes below the chat minimum', () => {
    expect(clampChatWidth(100, 1600, SIDEBAR_WIDTH)).toBe(CHAT_MIN_WIDTH);
  });

  it('leaves room for the graph', () => {
    expect(clampChatWidth(5000, 1600, SIDEBAR_WIDTH)).toBe(1600 - SIDEBAR_WIDTH - GRAPH_MIN_WIDTH);
  });

  it('prefers the chat minimum on tiny viewports', () => {
    expect(clampChatWidth(5000, 500, SIDEBAR_WIDTH)).toBe(CHAT_MIN_WIDTH);
  });
});

describe('defaultChatWidth', () => {
  it('is 42% of the viewport, at least 352px', () => {
    expect(defaultChatWidth(2000)).toBe(840);
    expect(defaultChatWidth(800)).toBe(352);
  });
});

describe('clampChatWidth with a side chat', () => {
  it('leaves room for the reserved side column', () => {
    expect(clampChatWidth(5000, 1600, SIDEBAR_WIDTH, 400)).toBe(
      1600 - SIDEBAR_WIDTH - GRAPH_MIN_WIDTH - 400,
    );
    expect(clampChatWidth(500, 1600, SIDEBAR_WIDTH, 400)).toBe(500);
  });

  it('still prefers the chat minimum', () => {
    expect(clampChatWidth(5000, 900, SIDEBAR_WIDTH, 600)).toBe(CHAT_MIN_WIDTH);
  });
});

describe('clampSideWidth', () => {
  it('keeps widths inside the allowed range untouched', () => {
    expect(clampSideWidth(420, 1600, SIDEBAR_WIDTH)).toBe(420);
  });

  it('never goes below the side minimum', () => {
    expect(clampSideWidth(50, 1600, SIDEBAR_WIDTH)).toBe(SIDE_MIN_WIDTH);
  });

  it('leaves room for the graph and the main chat', () => {
    expect(clampSideWidth(5000, 1600, SIDEBAR_WIDTH)).toBe(
      1600 - SIDEBAR_WIDTH - GRAPH_MIN_WIDTH - CHAT_MIN_WIDTH,
    );
  });

  it('prefers the side minimum on tiny viewports', () => {
    expect(clampSideWidth(5000, 600, SIDEBAR_WIDTH)).toBe(SIDE_MIN_WIDTH);
  });
});

describe('defaultSideWidth', () => {
  it('is 30% of the viewport, at least the chat minimum', () => {
    expect(defaultSideWidth(2000)).toBe(600);
    expect(defaultSideWidth(800)).toBe(CHAT_MIN_WIDTH);
  });
});
