import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { type RequestItem, requestResponse, requestText } from "./requests.ts";

const question: RequestItem = {
  type: "user_input_request",
  questions: [
    {
      id: "q1",
      header: "Tag",
      question: "Which tag?",
      options: [{ label: "v1" }, { label: "v2" }],
    },
    { id: "q2", header: "Why", question: "Why now?", options: [] },
  ],
};
const approval: RequestItem = {
  type: "approval_request",
  requestKind: "command",
  prompt: "git push origin wf/x",
  reason: "publish the branch",
};

describe("runtime requests", () => {
  it("tells Israel what the agent asks", () => {
    expect(requestText("user_input", question)).toBe(
      "Tag: Which tag? (options: v1, v2)\nWhy: Why now?",
    );
    expect(requestText("command", approval)).toBe(
      "The step's agent asks to approve a command request.\ngit push origin wf/x\npublish the branch",
    );
    expect(requestText("auth_refresh", undefined)).toBe(
      "The step's agent is waiting on a request (auth_refresh).",
    );
  });

  it("answers in the form the orchestrator accepts", () => {
    // The orchestrator refuses feedback with accept and needs user input keyed by question id.
    expect(requestResponse(question, { text: "v2" })).toEqual(
      Result.succeed({ answers: { q1: "v2", q2: "v2" } }),
    );
    expect(requestResponse(approval, { text: "ok" })).toEqual(
      Result.succeed({ decision: "accept" }),
    );
    expect(requestResponse(question, "decline")).toEqual(Result.succeed({ decision: "decline" }));
    expect(Result.isFailure(requestResponse(undefined, { text: "ok" }))).toBe(true);
  });
});
