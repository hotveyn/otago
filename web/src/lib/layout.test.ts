import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  clampChatWidth,
  defaultChatWidth,
  GRAPH_MIN_WIDTH,
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
