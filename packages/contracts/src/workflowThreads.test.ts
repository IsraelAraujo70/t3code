import { describe, expect, it } from "vite-plus/test";

import {
  isWorkflowStepLineage,
  isWorkflowStepThreadId,
  parseWorkflowItemThreadId,
  parseWorkflowStepThreadId,
  workflowItemThreadId,
  workflowStepThreadId,
} from "./workflowThreads.ts";
import { ThreadId } from "./baseSchemas.ts";
import { isListedThreadLineage } from "./orchestrationV2.ts";

const RUN = "wfr_0123456789abcdef0123";
const KEY16 = "0123456789abcdef";
const KEY64 = "a".repeat(64);

describe("workflow step thread ids", () => {
  it.each([
    [`wf:${RUN}:${KEY16}`, { runId: RUN, keyHash: KEY16 }],
    [`wf:${RUN}:${KEY64}`, { runId: RUN, keyHash: KEY64 }],
    [`wf:${RUN}:${"b".repeat(15)}`, null],
    [`wf:${RUN}:${"b".repeat(65)}`, null],
    [`wf:${RUN}:${KEY16.toUpperCase()}`, null],
    [`wf:wfr_0123456789abcdef012:${KEY16}`, null],
    [`wf:wfr_0123456789abcdef01234:${KEY16}`, null],
    [`wf:run_0123456789abcdef0123:${KEY16}`, null],
    [`wf:${RUN}`, null],
    [`wf:${RUN}:${KEY16}:extra`, null],
    [`x-wf:${RUN}:${KEY16}`, null],
    ["bot:abc:1", null],
  ] as const)("parses %s", (threadId, expected) => {
    expect(parseWorkflowStepThreadId(threadId)).toEqual(expected);
  });

  it.each([
    ["wf:", true],
    ["wf:anything", true],
    [`wf:${RUN}:${KEY16}`, true],
    ["WF:x", false],
    ["bot:abc:1", false],
    ["thread-wf:x", false],
    // A visible step thread is listed like any thread.
    [`wfi:${RUN}:${KEY16}`, false],
    ["", false],
  ] as const)("prefix check %s is %s", (threadId, expected) => {
    expect(isWorkflowStepThreadId(threadId)).toBe(expected);
  });

  it("round-trips the builders through the parsers", () => {
    const threadId = workflowStepThreadId(RUN, KEY64);
    expect(threadId).toBe(`wf:${RUN}:${KEY64}`);
    expect(parseWorkflowStepThreadId(threadId)).toEqual({ runId: RUN, keyHash: KEY64 });
    const visible = workflowItemThreadId(RUN, KEY16);
    expect(visible).toBe(`wfi:${RUN}:${KEY16}`);
    expect(parseWorkflowItemThreadId(visible)).toEqual({ runId: RUN, keyHash: KEY16 });
    expect(parseWorkflowStepThreadId(visible)).toBeNull();
  });

  it.each([
    [{ relationshipToParent: null, rootThreadId: `wf:${RUN}:${KEY16}` }, true],
    [{ relationshipToParent: "subagent", rootThreadId: `wf:${RUN}:${KEY16}` }, true],
    [{ relationshipToParent: "fork", rootThreadId: `wf:${RUN}:${KEY16}` }, false],
    [{ relationshipToParent: null, rootThreadId: "thread-1" }, false],
    [{ relationshipToParent: "subagent", rootThreadId: "thread-1" }, false],
  ] as const)("lineage %o is a step lineage: %s", (lineage, expected) => {
    expect(isWorkflowStepLineage(lineage)).toBe(expected);
  });

  it.each([
    [null, `wf:${RUN}:${KEY16}`, false],
    ["subagent", `wf:${RUN}:${KEY16}`, false],
    ["fork", `wf:${RUN}:${KEY16}`, true],
    [null, "thread-1", true],
    [null, `wfi:${RUN}:${KEY16}`, true],
  ] as const)(
    "lists a %s thread rooted at %s: %s",
    (relationshipToParent, rootThreadId, expected) => {
      expect(
        isListedThreadLineage({
          parentThreadId: null,
          relationshipToParent,
          rootThreadId: ThreadId.make(rootThreadId),
        }),
      ).toBe(expected);
    },
  );
});
