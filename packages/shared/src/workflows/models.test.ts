import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { isModelAlias, modelFamily, resolveModelUse } from "./models.ts";

describe("models", () => {
  it.each(["claude", "codex"] as const)("classifies %s", (provider) => {
    expect(modelFamily({ provider, model: "exact-id" })).toBe(
      provider === "claude" ? "claude" : "gpt",
    );
  });
  it.each([
    ["opus", true],
    ["Haiku", true],
    ["sonnet[1m]", true],
    [" fable ", true],
    ["claude-opus-5-5", false],
    ["opus-extra", false],
  ])("alias %s", (model, expected) => expect(isModelAlias(model)).toBe(expected));
  it.each([true, false])("resolves references, named=%s", (named) => {
    const ref = { provider: "codex", model: "gpt-6.1-sol" } as const;
    expect(resolveModelUse(named ? "$lead" : ref, { lead: ref })).toEqual(Result.succeed(ref));
  });
  it.each([undefined, {}])("reports missing references with %j", (models) => {
    const result = resolveModelUse("$lead", models);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toContain("$lead");
      expect(result.failure).toContain("models");
    }
  });
});
