import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError, isNodeMissing } from './chat-errors';

describe('describeError', () => {
  it('explains a structural 409', () => {
    const error = new ApiError(409, 'Tree "t" is busy', 'tree_busy_structural');
    expect(describeError(error)).toEqual({
      kind: 'busy-structural',
      message: 'Nodes are being moved or deleted. Try again in a moment.',
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

  it('uses the message of a plain Error', () => {
    expect(describeError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
  });

  it('stringifies non-Error values', () => {
    expect(describeError('oops')).toEqual({ kind: 'other', message: 'oops' });
    expect(isNodeMissing(null)).toBe(false);
  });
});
