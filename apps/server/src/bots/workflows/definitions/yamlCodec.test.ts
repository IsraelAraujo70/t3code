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
  it("has the four §11 routines", () => {
    expect(TEMPLATES.toSorted()).toEqual([
      "argo35-hillclimb.workflow.yaml",
      "corrections-quality.workflow.yaml",
      "mcp-token-cut.workflow.yaml",
      "upstream-merge.workflow.yaml",
    ]);
  });

  it.each(TEMPLATES)("%s compiles and keeps its hash through canonical YAML", (name) => {
    const compiled = compileSource(NodeFS.readFileSync(NodePath.join(LIBRARY, name), "utf8"));
    expect(`${compiled.definition.id}.workflow.yaml`).toBe(name);

    if (name === "upstream-merge.workflow.yaml") {
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
