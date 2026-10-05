import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError, describeQuestionFailure, isNodeMissing } from './chat-errors';

describe('describeError', () => {
  it('explains a structural 409', () => {
    const error = new ApiError(409, 'Tree "t" is busy', 'tree_busy_structural');
    expect(describeError(error)).toEqual({
      kind: 'busy-structural',
      message: 'Nodes are being moved, renamed or deleted. Try again in a moment.',
    });
  });

  it('explains a streaming 409', () => {
    const error = new ApiError(409, 'Tree "t" is busy', 'tree_busy_streaming');
    expect(describeError(error)).toEqual({
      kind: 'busy-streaming',
      message: 'An answer is still streaming. Try again when it finishes.',
    });
  });

  it('falls back to the server message for a 409 without a code', () => {
    expect(describeError(new ApiError(409, 'Tree "t" is busy'))).toEqual({
      kind: 'other',
      message: 'Tree "t" is busy',
    });
  });

  it('detects a missing node', () => {
    const error = new ApiError(404, 'Node not found: a/b');
    expect(describeError(error)).toEqual({ kind: 'node-missing', message: 'Node not found: a/b' });
    expect(isNodeMissing(error)).toBe(true);
    expect(isNodeMissing(new ApiError(404, 'Tree not found: t'))).toBe(false);
  });

  it('detects a missing node by its 404 code', () => {
    expect(isNodeMissing(new ApiError(404, 'gone', 'node_not_found'))).toBe(true);
    expect(isNodeMissing(new ApiError(404, 'gone', 'tree_not_found'))).toBe(false);
  });

  it('treats a missing parent of a send as a missing node', () => {
    const error = new ApiError(404, 'Parent node not found: a', 'parent_not_found');
    expect(describeError(error)).toEqual({
      kind: 'node-missing',
      message: 'The node this message goes under no longer exists (moved or deleted).',
    });
    expect(isNodeMissing(error)).toBe(true);
  });

  it('counts the blocking answers of a streaming 409', () => {
    const question = {
      id: 'q',
      tree: 't',
      parentId: '',
      context: { kind: 'main' },
      title: 'Q',
      status: 'streaming',
    };
    const error = new ApiError(409, 'busy', 'tree_busy_streaming', {
      questions: [question, { ...question, id: 'r' }],
      preparing: 1,
    });
    expect(describeError(error)).toEqual({
      kind: 'busy-streaming',
      message:
        '3 answers are still running in this tree. Try again when they finish, or cancel them.',
    });
  });

  it('explains the question codes', () => {
    expect(describeError(new ApiError(404, 'x', 'question_not_found')).message).toBe(
      'This question is no longer available.',
    );
    expect(describeError(new ApiError(409, 'x', 'question_finished')).message).toBe(
      'The answer was already saved.',
    );
  });

  it('uses the message of a plain Error', () => {
    expect(describeError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
  });

  it('localizes a failed attempt per code', () => {
    expect(describeQuestionFailure({ code: 'agent_error', message: 'boom' })).toBe(
      'The answer failed: boom',
    );
    expect(describeQuestionFailure({ code: 'timeout', message: 'x' })).toBe(
      'The answer took longer than 30 minutes and was stopped.',
    );
    expect(describeQuestionFailure({ code: 'internal', message: 'disk' })).toBe(
      'The answer could not be saved: disk',
    );
  });

  it('stringifies non-Error values', () => {
    expect(describeError('oops')).toEqual({ kind: 'other', message: 'oops' });
    expect(isNodeMissing(null)).toBe(false);
  });
});
