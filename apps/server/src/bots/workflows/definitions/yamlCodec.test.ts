// @effect-diagnostics nodeBuiltinImport:off - reads the library templates shipped beside the code.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow, DEFAULT_HOST_LIMITS, triggerParams } from "@t3tools/shared/workflows";

import { parseWorkflowSource, toCanonicalYaml } from "./yamlCodec.ts";

const HOST = DEFAULT_HOST_LIMITS;
const LIBRARY = NodePath.join(import.meta.dirname, "..", "library");
const TEMPLATES = NodeFS.readdirSync(LIBRARY).filter((name) => name.endsWith(".workflow.yaml"));

const compileSource = (source: string) => {
  const parsed = parseWorkflowSource(source);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  const compiled = compileWorkflow(parsed.success, HOST);
  if (Result.isFailure(compiled)) {
    throw new Error(compiled.failure.map((d) => `${d.path} ${d.code}: ${d.message}`).join("\n"));
  }
  return compiled.success;
};

describe("library templates", () => {
  it("has the four §11 routines and the callable pr-ci", () => {
    expect(TEMPLATES.toSorted()).toEqual([
      "argo35-hillclimb.workflow.yaml",
      "corrections-quality.workflow.yaml",
      "mcp-token-cut.workflow.yaml",
      "pr-ci.workflow.yaml",
      "upstream-merge.workflow.yaml",
    ]);
  });

  it.each(TEMPLATES)("%s compiles and keeps its hash through canonical YAML", (name) => {
    const compiled = compileSource(NodeFS.readFileSync(NodePath.join(LIBRARY, name), "utf8"));
    expect(`${compiled.definition.id}.workflow.yaml`).toBe(name);

    expect(
      Object.values(compiled.definition.triggers ?? {}).some(
        (trigger) => trigger.kind === "manual",
      ),
    ).toBe(true);

    if (name === "upstream-merge.workflow.yaml") {
      const ask = compiled.definition.triggers?.ask;
      expect(ask?.kind).toBe("bot");
      expect(ask?.kind === "bot" && ask.description.trim().length > 0).toBe(true);
      const trigger = compiled.definition.triggers?.newtag;
      expect(
        triggerParams(trigger && "params" in trigger ? trigger.params : undefined, {
          remote: "https://example.com/acme/app",
          kind: "upstreamTag",
          label: "x",
        }),
      ).toEqual({ upstream: "https://example.com/acme/app" });
      const upstream = compiled.definition.params?.upstream;
      expect(upstream?.type).toBe("string");
      if (upstream?.type === "string" && upstream.pattern) {
        expect(new RegExp(upstream.pattern).test(String(upstream.default))).toBe(true);
      }
    }

    const canonical = toCanonicalYaml(compiled.definition);
    const again = compileSource(canonical);
    expect(again.hash).toBe(compiled.hash);
    expect(toCanonicalYaml(again.definition)).toBe(canonical);
  });
});

describe("the pr-ci template", () => {
  it("documents a call with workspaces and threads that compiles against it", () => {
    const source = NodeFS.readFileSync(NodePath.join(LIBRARY, "pr-ci.workflow.yaml"), "utf8");
    const callee = compileSource(source).definition;
    // The caller's `ci` node, as the template's comment spells it.
    const snippet = source
      .split("\n")
      .filter((line) => line.startsWith("#   "))
      .map((line) => line.slice(2).replace(/\s+# .*$/, ""));
    expect(snippet[0]).toBe("  ci:");
    const caller = [
      "schema: t3.workflow/v1",
      "id: ticket",
      "title: Ticket",
      "home: { project: t3code }",
      "triggers: { run: { kind: manual } }",
      "budget: { steps: 40, wall: 4h, tokens: 3000000 }",
      "fatigue: { consecutiveFailures: 3 }",
      "models: { lead: { provider: claude, model: claude-opus-5-5 } }",
      "workspaces: { ticket: { project: t3code, base: friend/main, branch: wf/ticket } }",
      "nodes:",
      "  implement: { kind: agent, model: $lead, prompt: Implement., workspace: ticket, access: write }",
      "  publish:",
      "    { kind: agent, model: $lead, prompt: Publish., workspace: ticket, access: write,",
      '      thread: "continue:implement", output: { pr: { type: string, pattern: "^https://github\\\\.com/[A-Za-z0-9._/-]+/pull/\\\\d+$" } } }',
      ...snippet,
      "edges: [implement -> publish, publish -> ci]",
    ].join("\n");
    const parsed = parseWorkflowSource(caller);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    const compiled = compileWorkflow(parsed.success, {
      ...HOST,
      callTargets: new Map([["pr-ci", { from: null, definition: callee }]]),
    });
    expect(Result.isFailure(compiled) ? compiled.failure : []).toEqual([]);
    expect(Result.isSuccess(compiled) && compiled.success.definition.nodes.ci).toMatchObject({
      workspaces: { pr: "ticket" },
      threads: { fix: "implement" },
    });
  });
});

describe("parseWorkflowSource", () => {
  it.each([
    ["a syntax error", "nodes: [a, b", "Invalid YAML at line"],
    ["a duplicate key", "id: a\nid: b\n", "Invalid YAML at line 2"],
    ["an alias", "a: &x 1\nb: *x\n", "Invalid YAML"],
  ])("refuses %s as a schema diagnostic", (_case, source, message) => {
    const parsed = parseWorkflowSource(source);
    expect(Result.isFailure(parsed) && parsed.failure).toMatchObject({
      path: "",
      code: "schema",
      message: expect.stringContaining(message),
    });
  });
});
