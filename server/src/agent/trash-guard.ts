import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { DELETED_MARKER, DELETED_PATH_GLOB, TEMP_PREFIX } from '../storage/paths.js';

/** Tools whose path-like inputs are checked for soft-deleted and foreign staging folders. */
export const TRASH_GUARDED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Permission deny rule hiding soft-deleted folders from Read (and Grep/Glob ignore patterns).
 * There is no such rule for `.tmp-*`: the answer's own staging folder must stay readable, so
 * other answers' staging folders are denied by the hook only.
 */
export const TRASH_DENY_RULE = `Read(${DELETED_PATH_GLOB})`;

export const TRASH_DENY_REASON = 'Deleted nodes are not available';
export const STAGING_DENY_REASON = 'Other answers in progress are not available';

const PATH_KEYS = ['file_path', 'path', 'pattern', 'glob'] as const;

/** Path segments of the path-like inputs of a guarded tool call (`[]` for other tools). */
function pathSegments(toolName: string, input: unknown): string[] {
  if (!(TRASH_GUARDED_TOOLS as readonly string[]).includes(toolName)) return [];
  if (typeof input !== 'object' || input === null) return [];
  const record = input as Record<string, unknown>;
  // Grep's `pattern` is a regex over file contents, not a path.
  const keys = toolName === 'Grep' ? PATH_KEYS.filter((key) => key !== 'pattern') : PATH_KEYS;
  return keys.flatMap((key) => {
    const value = record[key];
    return typeof value === 'string' ? value.split(/[\\/]/) : [];
  });
}

/** True when a Read/Grep/Glob call targets a path inside (or naming) a soft-deleted folder. */
export function touchesDeletedPath(toolName: string, input: unknown): boolean {
  return pathSegments(toolName, input).some((segment) => segment.includes(DELETED_MARKER));
}

/**
 * True when a Read/Grep/Glob call targets another answer's staging folder: a path segment
 * starting with `.tmp-` that is not `ownTempName` (this answer's staging folder name).
 */
export function touchesForeignTemp(toolName: string, input: unknown, ownTempName: string): boolean {
  return pathSegments(toolName, input).some(
    (segment) => segment.startsWith(TEMP_PREFIX) && segment !== ownTempName,
  );
}

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * PreToolUse hook denying tool calls that touch soft-deleted folders or the staging folders of
 * other answers in progress. `ownTempName` stays readable.
 */
export function createPathGuardHook(options: { ownTempName: string }): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (touchesDeletedPath(input.tool_name, input.tool_input)) return deny(TRASH_DENY_REASON);
    if (touchesForeignTemp(input.tool_name, input.tool_input, options.ownTempName)) {
      return deny(STAGING_DENY_REASON);
    }
    return {};
  };
}

export function pathGuardMatcher(ownTempName: string): HookCallbackMatcher {
  return {
    matcher: TRASH_GUARDED_TOOLS.join('|'),
    hooks: [createPathGuardHook({ ownTempName })],
  };
}
