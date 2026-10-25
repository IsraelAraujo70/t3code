export const SUBAGENTS_PER_TURN: number;
/** What the hook prints for one Claude Code hook event, or null for nothing. */
export function applyHookEvent(
  event: unknown,
  root: string,
  limit?: number,
): { hookSpecificOutput: Record<string, string> } | null;
