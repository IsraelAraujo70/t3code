import { WorkflowDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { compileWorkflowEdit, workflowEditDraft } from "./workflowEdit.logic";

const decodeDefinition = Schema.decodeUnknownSync(WorkflowDefinition);
const definition = () =>
  decodeDefinition({
    schema: "t3.workflow/v1",
    id: "phone",
    title: "Phone",
    home: { project: "t3code" },
    budget: { steps: 10, wall: "2h", tokens: 100000 },
    fatigue: { consecutiveFailures: 2 },
    triggers: { nightly: { kind: "cron", expr: "0 0 * * *", tz: "UTC" } },
    params: {
      text: { type: "string", default: "hello" },
      count: { type: "number", default: 2 },
      flag: { type: "boolean", default: false },
    },
    workspaces: { work: { project: "t3code", base: "main", branch: "wf/phone-{{run.id}}" } },
    nodes: {
      plan: {
        kind: "agent",
        model: { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
        prompt: "Plan",
        workspace: "work",
      },
      done: { kind: "output", status: "ready_for_review", value: {} },
    },
    edges: ["plan -> done"],
  });

describe("phone workflow edits", () => {
  it("compiles valid edits and preserves typed parameter defaults and graph topology", () => {
    const original = definition();
    const draft = workflowEditDraft(original);
    const result = compileWorkflowEdit(original, {
      ...draft,
      params: { text: "42", count: "42", flag: "true" },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.definition.params).toMatchObject({
      text: { default: "42" },
      count: { default: 42 },
      flag: { default: true },
    });
    expect(result.definition.edges).toEqual(original.edges);
    expect(Object.keys(result.definition.nodes)).toEqual(Object.keys(original.nodes));
    expect(original.params?.count?.default).toBe(2);
  });
  it.each([
    { expr: "invalid", tz: "UTC" },
    { expr: "0 0 * * *", tz: "invalid/zone" },
  ])("rejects invalid cron settings %j", (cron) => {
    const original = definition();
    const draft = workflowEditDraft(original);
    expect(
      compileWorkflowEdit(original, { ...draft, cron: { nightly: cron } }).diagnostics.length,
    ).toBeGreaterThan(0);
  });
  it("rejects an empty prompt and invalid typed defaults before saving", () => {
    const original = definition();
    const draft = workflowEditDraft(original);
    const plan = draft.agents.plan!;
    const result = compileWorkflowEdit(original, {
      ...draft,
      agents: { plan: { ...plan, prompt: "  " } },
      params: { ...draft.params, count: "no", flag: "maybe" },
    });
    expect(result.diagnostics.map((d) => d.path)).toEqual(
      expect.arrayContaining(["nodes.plan.prompt", "params.count.default", "params.flag.default"]),
    );
  });
});
