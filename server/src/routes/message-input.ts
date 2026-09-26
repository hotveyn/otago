// Constants mirror .claude/features/chat-file-attachments/contracts/messages.ts
import type { Multipart, MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { InvalidBodyError, UploadError } from '../errors.js';
import {
  MAX_MESSAGE_FILE_BYTES,
  MAX_MESSAGE_FILES,
  type UserFileStager,
} from '../storage/index.js';
import { nodeId } from './schemas.js';

export const MESSAGE_PAYLOAD_FIELD = 'payload';
export const MESSAGE_FILES_FIELD = 'files';
export const MESSAGE_TEXT_MAX = 50_000;
/** Max bytes of the `payload` field value. */
export const MESSAGE_PAYLOAD_MAX_BYTES = 256 * 1024;
/** Question given to the agent when the user sent files without text. */
export const EMPTY_TEXT_QUESTION =
  'The user sent the attached files without a message. Look at them and respond helpfully.';

/** JSON body (no files). `text` is required. */
export const messageBody = z.object({
  parentId: nodeId,
  text: z.string().trim().min(1).max(MESSAGE_TEXT_MAX),
  /** Answer model; defaults to `OTAGO_MODEL`. */
  model: z.string().optional(),
  /** Node naming model; defaults to `OTAGO_NAMING_MODEL`. */
  namingModel: z.string().optional(),
});

/**
 * `payload` field of a multipart message. `text` may be empty when files are attached.
 * Unknown keys are stripped (seam for a future `urls` field).
 */
export const messagePayload = messageBody.extend({
  text: z.string().trim().max(MESSAGE_TEXT_MAX).default(''),
});

export type MessageBody = z.infer<typeof messagePayload>;

export interface MultipartMessageInput {
  kind: 'multipart';
  body: MessageBody;
  parts: AsyncIterableIterator<Multipart>;
  /** File part being received; drained first when the request is rejected. */
  current?: MultipartFile;
  request: FastifyRequest;
}

export type MessageInput = { kind: 'json'; body: MessageBody } | MultipartMessageInput;

/** Plugin error codes → upload errors. Anything else passes through. */
export function mapMultipartError(error: unknown): unknown {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  switch (code) {
    case 'FST_FILES_LIMIT':
      return new UploadError(
        `Too many files: at most ${MAX_MESSAGE_FILES} per message`,
        'too_many_files',
      );
    case 'FST_REQ_FILE_TOO_LARGE':
      return new UploadError(
        `A file is larger than ${MAX_MESSAGE_FILE_BYTES / (1024 * 1024)} MB`,
        'file_too_large',
      );
    case 'FST_FIELDS_LIMIT':
    case 'FST_PARTS_LIMIT':
    case 'FST_INVALID_JSON_FIELD_ERROR':
    case 'FST_PROTO_VIOLATION':
      return new UploadError(
        `Invalid message form: only one "${MESSAGE_PAYLOAD_FIELD}" field and up to ${MAX_MESSAGE_FILES} "${MESSAGE_FILES_FIELD}" files are allowed`,
        'invalid_payload',
      );
    default:
      return error;
  }
}

async function nextPart(parts: AsyncIterableIterator<Multipart>): Promise<Multipart | undefined> {
  try {
    const result = await parts.next();
    return result.done ? undefined : result.value;
  } catch (error) {
    throw mapMultipartError(error);
  }
}

function parsePayload(value: unknown): MessageBody {
  let data = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      throw new UploadError(
        `The "${MESSAGE_PAYLOAD_FIELD}" field must be valid JSON`,
        'invalid_payload',
      );
    }
  }
  const parsed = messagePayload.safeParse(data);
  if (!parsed.success) throw new InvalidBodyError(parsed.error.issues);
  return parsed.data;
}

/**
 * Decode the message request. JSON: validate the body. Multipart: open the part iterator with
 * route-specific limits and read the leading `payload` field; files stay unread.
 */
export async function openMessageInput(request: FastifyRequest): Promise<MessageInput> {
  if (!request.isMultipart()) {
    const parsed = messageBody.safeParse(request.body);
    if (!parsed.success) throw new InvalidBodyError(parsed.error.issues);
    return { kind: 'json', body: parsed.data };
  }
  const parts = request.parts({
    limits: {
      // One more than allowed, so the 11th file reaches us and gets a clear 400.
      files: MAX_MESSAGE_FILES + 1,
      fileSize: MAX_MESSAGE_FILE_BYTES,
      fields: 1,
      fieldSize: MESSAGE_PAYLOAD_MAX_BYTES,
      parts: MAX_MESSAGE_FILES + 2,
    },
  });
  const input: Omit<MultipartMessageInput, 'body'> = { kind: 'multipart', parts, request };
  try {
    const first = await nextPart(parts);
    if (first?.type === 'file') input.current = first;
    if (first?.type !== 'field' || first.fieldname !== MESSAGE_PAYLOAD_FIELD) {
      throw new UploadError(
        `The "${MESSAGE_PAYLOAD_FIELD}" field must come first`,
        'invalid_payload',
      );
    }
    if (first.valueTruncated) {
      throw new UploadError(`The "${MESSAGE_PAYLOAD_FIELD}" field is too large`, 'invalid_payload');
    }
    return { ...input, body: parsePayload(first.value) };
  } catch (error) {
    await drainParts(input);
    throw error;
  }
}

/** Stage every remaining part; each must be a file named `files`. */
export async function receiveUserFiles(
  input: MultipartMessageInput,
  stager: UserFileStager,
): Promise<void> {
  for (;;) {
    const part = await nextPart(input.parts);
    if (!part) return;
    if (part.type === 'file') input.current = part;
    if (part.type !== 'file' || part.fieldname !== MESSAGE_FILES_FIELD) {
      throw new UploadError(
        `Unexpected form part "${part.fieldname}": files must be sent as "${MESSAGE_FILES_FIELD}"`,
        'invalid_payload',
      );
    }
    try {
      await stager.addFromStream({
        filename: part.filename,
        mimetype: part.mimetype,
        stream: part.file,
      });
    } catch (error) {
      throw mapMultipartError(error);
    }
    input.current = undefined;
  }
}

/**
 * Best-effort: read the rest of a rejected upload, so the client gets the JSON error instead
 * of a connection reset. Bounded by the route limits; errors are swallowed.
 */
export async function drainParts(input: Omit<MultipartMessageInput, 'body'>): Promise<void> {
  const raw = input.request.raw;
  const skip = (file: MultipartFile['file']) => {
    if (file.readableEnded || file.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      file
        .once('end', resolve)
        .once('close', resolve)
        .once('error', () => resolve());
      file.resume();
    });
  };
  try {
    if (input.current) await skip(input.current.file);
    input.current = undefined;
    for (;;) {
      if (raw.destroyed) return;
      const result = await input.parts.next();
      if (result.done) return;
      if (result.value.type === 'file') await skip(result.value.file);
    }
  } catch {
    // The client is gone or the body is malformed; the error reply is sent anyway.
  }
}
