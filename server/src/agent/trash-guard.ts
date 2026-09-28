import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { DELETED_MARKER, DELETED_PATH_GLOB } from '../storage/paths.js';

/** Tools whose path-like inputs are checked for soft-deleted folders. */
export const TRASH_GUARDED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Permission deny rule hiding soft-deleted folders from Read (and Grep/Glob ignore patterns). */
export const TRASH_DENY_RULE = `Read(${DELETED_PATH_GLOB})`;

export const TRASH_DENY_REASON = 'Deleted nodes are not available';

const PATH_KEYS = ['file_path', 'path', 'pattern', 'glob'] as const;

/** True when a Read/Grep/Glob call targets a path inside (or naming) a soft-deleted folder. */
export function touchesDeletedPath(toolName: string, input: unknown): boolean {
  if (!(TRASH_GUARDED_TOOLS as readonly string[]).includes(toolName)) return false;
  if (typeof input !== 'object' || input === null) return false;
  const record = input as Record<string, unknown>;
  // Grep's `pattern` is a regex over file contents, not a path.
  const keys = toolName === 'Grep' ? PATH_KEYS.filter((key) => key !== 'pattern') : PATH_KEYS;
  return keys.some((key) => {
    const value = record[key];
    return (
      typeof value === 'string' &&
      value.split(/[\\/]/).some((segment) => segment.includes(DELETED_MARKER))
    );
  });
}

/** PreToolUse hook denying tool calls that touch soft-deleted folders. */
export function createTrashGuardHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (!touchesDeletedPath(input.tool_name, input.tool_input)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: TRASH_DENY_REASON,
      },
    };
  };
}

export function trashGuardMatcher(): HookCallbackMatcher {
  return { matcher: TRASH_GUARDED_TOOLS.join('|'), hooks: [createTrashGuardHook()] };
}
