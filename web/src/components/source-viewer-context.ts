import { createContext, useContext } from 'react';
import type { AttachmentInfo, FileFolder } from '../api/types';

export interface SourceView {
  file: string;
  start?: number;
  end?: number;
}

export const SourceViewerContext = createContext<(view: SourceView) => void>(() => {});

export const useOpenSource = () => useContext(SourceViewerContext);

export interface AttachmentView {
  treeId: string;
  nodeId: string;
  attachment: AttachmentInfo;
  /** Show a table (or any file) as plain text, e.g. after a CSV parse failure. */
  asText?: boolean;
  /** Node folder the file lives in; defaults to agent `attachments`. */
  folder?: FileFolder;
  /** 1-based lines to scroll to and highlight (`text` kind only, e.g. a cited user file). */
  start?: number;
  end?: number;
}

export const AttachmentViewerContext = createContext<(view: AttachmentView) => void>(() => {});

export const useOpenAttachment = () => useContext(AttachmentViewerContext);
