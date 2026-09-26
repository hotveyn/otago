/**
 * User files attached to a chat message: constants and pure helpers.
 * Constants mirror .claude/features/chat-file-attachments/contracts/messages.ts and
 * .claude/features/chat-file-attachments/contracts/user-files.ts (server owns them and is
 * authoritative; these checks only give early feedback).
 * Types only from `api/`: this module must not import `api/client.ts`.
 */
import { i18n } from '../i18n';

/** Multipart field carrying the JSON `MessagePayload`; must be the first part. */
export const MESSAGE_PAYLOAD_FIELD = 'payload';
/** Multipart field name of every file part. */
export const MESSAGE_FILES_FIELD = 'files';

/** Max user files per message (picker + paste + drop combined). */
export const MAX_MESSAGE_FILES = 10;
/** Per-file cap in bytes (20 MiB). */
export const MAX_MESSAGE_FILE_BYTES = 20 * 1024 * 1024;

/** Allowed extensions; matched case-insensitively by longest suffix (`.fb2.zip` first). */
export const MESSAGE_FILE_EXTENSIONS = [
  '.fb2.zip',
  '.md',
  '.txt',
  '.pdf',
  '.epub',
  '.fb2',
  '.mobi',
  '.azw',
  '.azw3',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
] as const;

export const MESSAGE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

/** Extension for a file without an allowed one (e.g. a nameless clipboard image). */
export const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** `<input accept>`: browsers mishandle compound extensions, so `.fb2.zip` becomes `.zip`. */
export const CHAT_FILE_ACCEPT = [
  ...new Set(MESSAGE_FILE_EXTENSIONS.map((ext) => (ext === '.fb2.zip' ? '.zip' : ext))),
].join(',');

const PASTED_STEM = 'pasted-image';

const isImageMime = (type: string) => Object.hasOwn(IMAGE_MIME_EXTENSIONS, type);

/** One file waiting in the composer. `id` is stable for keys and removal. */
export interface ComposerFile {
  id: number;
  file: File;
}

/** A file the composer refused, with a user-facing reason. */
export interface RejectedFile {
  name: string;
  reason: string;
}

const BY_LENGTH = [...MESSAGE_FILE_EXTENSIONS].sort((a, b) => b.length - a.length);

/** Allowed extension of `name` (lowercase, longest suffix); undefined without a stem. */
export function chatFileExtensionOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  return BY_LENGTH.find((ext) => lower.length > ext.length && lower.endsWith(ext));
}

/** Image by extension, or a file without an allowed extension but with an image MIME type. */
export function isChatImage(file: File): boolean {
  const ext = chatFileExtensionOf(file.name);
  if (ext) return (MESSAGE_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
  return isImageMime(file.type);
}

export function allowedTypesLabel(): string {
  return MESSAGE_FILE_EXTENSIONS.join(', ');
}

const fileKey = (file: File) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

const displayName = (file: File) => file.name || i18n.t('chat:files.pasted');

/**
 * Split `incoming` into files to add and rejections, given what the composer already holds.
 * Exact duplicates (same name, size and lastModified) are skipped silently.
 */
export function validateChatFiles(
  current: readonly ComposerFile[],
  incoming: readonly File[],
): { accepted: File[]; rejected: RejectedFile[] } {
  const seen = new Set(current.map((item) => fileKey(item.file)));
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of incoming) {
    const key = fileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = displayName(file);
    if (!chatFileExtensionOf(file.name) && !isImageMime(file.type))
      rejected.push({
        name,
        reason: i18n.t('chat:files.unsupported', { allowed: allowedTypesLabel() }),
      });
    else if (file.size === 0) rejected.push({ name, reason: i18n.t('chat:files.empty') });
    else if (file.size > MAX_MESSAGE_FILE_BYTES)
      rejected.push({ name, reason: i18n.t('chat:files.tooLarge') });
    else if (current.length + accepted.length >= MAX_MESSAGE_FILES)
      rejected.push({ name, reason: i18n.t('chat:files.tooMany', { max: MAX_MESSAGE_FILES }) });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** A clipboard image without an allowed extension gets `pasted-image-<index><ext>`. */
export function normalizePastedFile(file: File, index: number): File {
  if (chatFileExtensionOf(file.name)) return file;
  if (!isImageMime(file.type)) return file;
  const ext = IMAGE_MIME_EXTENSIONS[file.type] ?? '';
  return new File([file], `${PASTED_STEM}-${index}${ext}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/**
 * Files of a paste event. `blockText` says the plain-text flavour only repeats the files
 * (no text at all, or just their names), so the default paste should be prevented.
 */
export function pastedFilesToAdd(data: Pick<DataTransfer, 'files' | 'types' | 'getData'>): {
  files: File[];
  blockText: boolean;
} {
  const original = Array.from(data.files ?? []);
  if (original.length === 0) return { files: [], blockText: false };
  const files = original.map((file, index) => normalizePastedFile(file, index + 1));
  if (!Array.from(data.types).includes('text/plain')) return { files, blockText: true };
  const lines = data
    .getData('text/plain')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const names = original.map((file) => file.name);
  const blockText = lines.length === 0 || lines.join('\n') === names.join('\n');
  return { files, blockText };
}

/** Text or at least one file, and nothing streaming. */
export function canSend(text: string, files: readonly unknown[], streaming: boolean): boolean {
  return !streaming && (text.trim() !== '' || files.length > 0);
}

/** After a failed send: keep files added meanwhile, otherwise bring the sent ones back. */
export function restoreFiles(current: ComposerFile[], snapshot: ComposerFile[]): ComposerFile[] {
  return current.length ? current : snapshot;
}

let nextFileId = 1;

export function toComposerFiles(files: readonly File[]): ComposerFile[] {
  return files.map((file) => ({ id: nextFileId++, file }));
}
