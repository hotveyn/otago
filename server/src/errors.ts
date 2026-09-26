export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional machine-readable code sent as `code` in the JSON error body. */
    readonly code?: ConflictCode | UploadErrorCode | (string & {}),
    /** Optional extra data sent as `details` in the JSON error body. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message);
  }
}

export class InvalidInputError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}

/** Machine-readable reason of a 409 tree-lock conflict. */
export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';

export class ConflictError extends AppError {
  constructor(message: string, code?: ConflictCode) {
    super(409, message, code);
  }
}

/** Machine-readable reason of a message-upload rejection. */
export type UploadErrorCode =
  | 'invalid_payload'
  | 'empty_message'
  | 'too_many_files'
  | 'unsupported_file_type'
  | 'empty_file'
  | 'unreadable_file'
  | 'file_too_large';

/** Rejected message upload: 413 for `file_too_large`, 400 otherwise. */
export class UploadError extends AppError {
  constructor(message: string, code: UploadErrorCode) {
    super(code === 'file_too_large' ? 413 : 400, message, code);
  }
}

/** Body validation failure with the same shape as route-schema errors. */
export class InvalidBodyError extends AppError {
  constructor(details: unknown) {
    super(400, 'Invalid input', undefined, details);
  }
}

/** Failure of one attachment save. The message is meant for the agent (and the UI). */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}
