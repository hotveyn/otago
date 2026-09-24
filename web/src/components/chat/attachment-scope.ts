import { createContext, useContext } from 'react';
import type { AttachmentScopeValue } from '../../lib/attachments';

export type { AttachmentScopeValue } from '../../lib/attachments';

/** Which node (or streaming answer) in-text `attachments/<name>` references resolve against. */
export const AttachmentScope = createContext<AttachmentScopeValue | null>(null);

export const useAttachmentScope = () => useContext(AttachmentScope);
