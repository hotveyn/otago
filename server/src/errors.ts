export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional machine-readable code sent as `code` in the JSON error body. */
    readonly code?:
      | ConflictCode
      | QuestionConflictCode
      | UploadErrorCode
      | NotFoundCode
      | (string & {}),
    /** Optional extra data sent as `details` in the JSON error body. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Machine-readable reason of a 404. */
export type NotFoundCode =
  | 'node_not_found'
  | 'parent_not_found'
  | 'trash_not_found'
  | 'tree_not_found'
  | 'question_not_found';

export class NotFoundError extends AppError {
  constructor(message: string, code?: NotFoundCode) {
    super(404, message, code);
  }
}

export class InvalidInputError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}

/** Machine-readable reason of a 409 tree-lock conflict. */
export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';

/** Machine-readable reason of a 409 on a question route. */
export type QuestionConflictCode = 'question_finished' | 'question_not_failed';

export class ConflictError extends AppError {
  constructor(message: string, code?: ConflictCode | QuestionConflictCode, details?: unknown) {
    super(409, message, code, details);
  }
}

/**
 * 409 of the tree lock. `holders` are the shared-lock holder ids at throw time; the central
 * error handler turns them into `details` (`TreeBusyDetails`) for `tree_busy_streaming`.
 */
export class TreeBusyError extends ConflictError {
  constructor(
    message: string,
    code: ConflictCode,
    readonly treeId: string,
    readonly holders: readonly string[],
  ) {
    super(message, code);
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
