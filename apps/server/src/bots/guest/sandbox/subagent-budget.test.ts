// Plain-Node test of a hook script that keeps its budget in files.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { applyHookEvent } from "./subagent-budget.mjs";

const prompt = (session: string) => ({ hook_event_name: "UserPromptSubmit", session_id: session });
const spawn = (session: string) => ({
  hook_event_name: "PreToolUse",
  session_id: session,
  tool_name: "Agent",
});
const denied = (output: ReturnType<typeof applyHookEvent>) =>
  output?.hookSpecificOutput.permissionDecision === "deny";

it("allows the turn's budget of helpers, denies the next, and starts over with a new message", () => {
  using root = scratch();
  applyHookEvent(prompt("s1"), root.path, 2);
  expect(denied(applyHookEvent(spawn("s1"), root.path, 2))).toBe(false);
  expect(denied(applyHookEvent(spawn("s1"), root.path, 2))).toBe(false);
  expect(denied(applyHookEvent(spawn("s1"), root.path, 2))).toBe(true);

  // Another conversation in the same container keeps its own budget.
  expect(denied(applyHookEvent(spawn("s2"), root.path, 2))).toBe(false);

  expect(applyHookEvent(prompt("s1"), root.path, 2)).toBeNull();
  expect(denied(applyHookEvent(spawn("s1"), root.path, 2))).toBe(false);
});

it("keeps a session id from naming a path outside its budget folder", () => {
  using root = scratch();
  applyHookEvent(spawn("../../escape"), root.path, 1);
  expect(NodeFS.readdirSync(root.path)).toEqual(["______escape"]);
});

function scratch() {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-subagent-budget-"));
  return { path, [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }) };
}
