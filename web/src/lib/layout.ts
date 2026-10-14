import { useCallback, useEffect, useState } from 'react';
import { safeStorage } from './storage';

export const SIDEBAR_WIDTH = 211;
export const SIDEBAR_COLLAPSED_WIDTH = 38;
export const CHAT_MIN_WIDTH = 288;
/** The graph never shrinks below this while dragging the splitter. */
export const GRAPH_MIN_WIDTH = 176;

export const SIDE_MIN_WIDTH = CHAT_MIN_WIDTH;

const SIDEBAR_KEY = 'otago.sidebar-collapsed';
const CHAT_WIDTH_KEY = 'otago.chat-width';
export const SIDE_WIDTH_KEY = 'otago.side-width';

export function sidebarWidth(collapsed: boolean): number {
  return collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH;
}

/** Initial chat width when the user hasn't dragged the splitter yet. */
export function defaultChatWidth(viewport: number): number {
  return Math.max(352, Math.round(viewport * 0.42));
}

/** Initial side chat width when the user hasn't dragged its splitter yet. */
export function defaultSideWidth(viewport: number): number {
  return Math.max(CHAT_MIN_WIDTH, Math.round(viewport * 0.3));
}

/**
 * The chat area is everything right of the graph: the main chat plus, while it is open,
 * the side chat. Keep it wide enough to read and the graph wide enough to see.
 */
export function clampChatAreaWidth(
  width: number,
  viewport: number,
  sidebar: number,
  sideOpen = false,
): number {
  const min = CHAT_MIN_WIDTH + (sideOpen ? SIDE_MIN_WIDTH : 0);
  const max = Math.max(min, viewport - sidebar - GRAPH_MIN_WIDTH);
  return Math.round(Math.min(Math.max(width, min), max));
}

/** Keep the side chat readable while leaving the main chat its minimum inside the area. */
export function clampSideWidth(width: number, area: number): number {
  const max = Math.max(SIDE_MIN_WIDTH, area - CHAT_MIN_WIDTH);
  return Math.round(Math.min(Math.max(width, SIDE_MIN_WIDTH), max));
}

function parseWidth(raw: string | null): number | null {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

export interface PaneLayout {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  sidebarWidth: number;
  /** Main chat pane, clamped to the current viewport. */
  chatWidth: number;
  /** Widest the main chat can get without the graph going below its minimum. */
  chatMaxWidth: number;
  setChatWidth: (width: number) => void;
  resetChatWidth: () => void;
  /** Side chat pane, clamped to the current viewport. */
  sideWidth: number;
  /** Widest the side chat can get without the main chat going below its minimum. */
  sideMaxWidth: number;
  setSideWidth: (width: number) => void;
  resetSideWidth: () => void;
  viewport: number;
}

/**
 * Sidebar collapse + chat/graph and side chat splitter positions, persisted per browser.
 * The stored chat width is the whole chat area (graph splitter to the right edge). The side
 * chat takes its width out of the main chat, so opening or closing it never moves the graph
 * splitter; only when the area is too small for both does it grow into the graph.
 */
export function usePaneLayout(sideOpen = false): PaneLayout {
  const viewport = useViewportWidth();
  const [sidebarCollapsed, setCollapsed] = useState(() => safeStorage.get(SIDEBAR_KEY) === '1');
  const [storedChat, setStoredChat] = useState(() => parseWidth(safeStorage.get(CHAT_WIDTH_KEY)));
  const [storedSide, setStoredSide] = useState(() => parseWidth(safeStorage.get(SIDE_WIDTH_KEY)));

  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => {
      safeStorage.set(SIDEBAR_KEY, prev ? null : '1');
      return !prev;
    });
  }, []);

  const sidebar = sidebarWidth(sidebarCollapsed);
  const area = clampChatAreaWidth(
    storedChat ?? defaultChatWidth(viewport),
    viewport,
    sidebar,
    sideOpen,
  );
  const sideWidth = clampSideWidth(storedSide ?? defaultSideWidth(viewport), area);
  const reserved = sideOpen ? sideWidth : 0;
  const chatWidth = area - reserved;
  const chatMaxWidth =
    clampChatAreaWidth(Number.POSITIVE_INFINITY, viewport, sidebar, sideOpen) - reserved;
  const sideMaxWidth = clampSideWidth(Number.POSITIVE_INFINITY, area);

  const setChatWidth = useCallback(
    (width: number) => {
      const next = clampChatAreaWidth(width + reserved, window.innerWidth, sidebar, sideOpen);
      setStoredChat(next);
      safeStorage.set(CHAT_WIDTH_KEY, String(next));
    },
    [sidebar, reserved, sideOpen],
  );

  const setSideWidth = useCallback(
    (width: number) => {
      const next = clampSideWidth(width, area);
      setStoredSide(next);
      safeStorage.set(SIDE_WIDTH_KEY, String(next));
    },
    [area],
  );

  const resetSideWidth = useCallback(() => {
    setStoredSide(null);
    safeStorage.set(SIDE_WIDTH_KEY, null);
  }, []);

  const resetChatWidth = useCallback(() => {
    setStoredChat(null);
    safeStorage.set(CHAT_WIDTH_KEY, null);
  }, []);

  // Ctrl/Cmd+B toggles the sidebar, like most editors.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  return {
    sidebarCollapsed,
    toggleSidebar,
    sidebarWidth: sidebar,
    chatWidth,
    chatMaxWidth,
    setChatWidth,
    resetChatWidth,
    sideWidth,
    sideMaxWidth,
    setSideWidth,
    resetSideWidth,
    viewport,
  };
}
