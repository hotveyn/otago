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
 * Keep the chat wide enough to read and the graph wide enough to see.
 * `reserved` is space taken by other columns (the open side chat).
 */
export function clampChatWidth(
  width: number,
  viewport: number,
  sidebar: number,
  reserved = 0,
): number {
  const max = Math.max(CHAT_MIN_WIDTH, viewport - sidebar - GRAPH_MIN_WIDTH - reserved);
  return Math.round(Math.min(Math.max(width, CHAT_MIN_WIDTH), max));
}

/** Keep the side chat readable while leaving room for the graph and the main chat. */
export function clampSideWidth(width: number, viewport: number, sidebar: number): number {
  const max = Math.max(SIDE_MIN_WIDTH, viewport - sidebar - GRAPH_MIN_WIDTH - CHAT_MIN_WIDTH);
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
  /** Clamped to the current viewport. */
  chatWidth: number;
  setChatWidth: (width: number) => void;
  resetChatWidth: () => void;
  /** Clamped to the current viewport. */
  sideWidth: number;
  setSideWidth: (width: number) => void;
  resetSideWidth: () => void;
  viewport: number;
}

/**
 * Sidebar collapse + chat/graph and side chat splitter positions, persisted per browser.
 * While the side chat is open the main chat shrinks first; the side keeps its width.
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
  const sideWidth = clampSideWidth(storedSide ?? defaultSideWidth(viewport), viewport, sidebar);
  const reserved = sideOpen ? sideWidth : 0;
  const chatWidth = clampChatWidth(
    storedChat ?? defaultChatWidth(viewport),
    viewport,
    sidebar,
    reserved,
  );

  const setChatWidth = useCallback(
    (width: number) => {
      const next = clampChatWidth(width, window.innerWidth, sidebar, reserved);
      setStoredChat(next);
      safeStorage.set(CHAT_WIDTH_KEY, String(next));
    },
    [sidebar, reserved],
  );

  const setSideWidth = useCallback(
    (width: number) => {
      const next = clampSideWidth(width, window.innerWidth, sidebar);
      setStoredSide(next);
      safeStorage.set(SIDE_WIDTH_KEY, String(next));
    },
    [sidebar],
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
    setChatWidth,
    resetChatWidth,
    sideWidth,
    setSideWidth,
    resetSideWidth,
    viewport,
  };
}
