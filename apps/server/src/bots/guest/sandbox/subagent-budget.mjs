// Claude Code hook in the guest sandbox (friend fork): at most SUBAGENTS_PER_TURN helper agents
// per user message. Managed settings run it on UserPromptSubmit, which starts a new budget, and
// before every Agent/Task call and every SendMessage (which resumes a finished helper); each takes
// one slot or is denied. Concurrency, nesting depth, models and effort are capped elsewhere and do
// not depend on this file. The budget lives in /tmp, which the bot could clear, so it bounds an
// honest bot's spending, not a hostile one's.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export const SUBAGENTS_PER_TURN = 4;

/** Pure. The hook output that refuses one more subagent this turn. */
function denial(limit) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `This message already used its ${limit} helper agents. Finish the work yourself, or tell the user what is left and let them ask again.`,
    },
  };
}

/**
 * Applies one hook event to the budget directory and returns what the hook prints (null for
 * nothing). Slots are files created exclusively, so helpers started at once cannot share one.
 */
export function applyHookEvent(event, root, limit = SUBAGENTS_PER_TURN) {
  const session = String(event?.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = `${root}/${session}`;
  if (event?.hook_event_name === "UserPromptSubmit") {
    NodeFS.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  if (event?.hook_event_name !== "PreToolUse") return null;
  NodeFS.mkdirSync(dir, { recursive: true });
  for (let slot = 1; slot <= limit; slot++) {
    try {
      NodeFS.writeFileSync(`${dir}/${slot}`, "", { flag: "wx" });
      return null;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return denial(limit);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const input = NodeFS.readFileSync(0, "utf8");
  const output = applyHookEvent(JSON.parse(input), "/tmp/t3-guest-subagents");
  if (output !== null) process.stdout.write(JSON.stringify(output));
}
