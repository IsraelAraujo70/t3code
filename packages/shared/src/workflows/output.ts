import * as Result from "effect/Result";

import type { WorkflowFieldSpec, WorkflowOutputShape } from "@t3tools/contracts";

import type { JsonValue } from "./types.ts";

/**
 * Whether the whole value matches a field's or param's pattern. Anchored on purpose: a pattern
 * makes a value trusted in argv, env and refs, so `[a-z-]+` must not pass `x --upload-pack=y`.
 */
export const matchesWhole = (pattern: string, value: string): boolean => {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return false;
  }
};

const fieldError = (name: string, spec: WorkflowFieldSpec, value: JsonValue): string | null => {
  const strings = (items: ReadonlyArray<JsonValue>) =>
    items.every((item) => typeof item === "string");
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return `${name} must be a string`;
      return spec.pattern !== undefined && !matchesWhole(spec.pattern, value)
        ? `${name} does not match ${spec.pattern}`
        : null;
    case "number":
      return typeof value === "number" ? null : `${name} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${name} must be a boolean`;
    case "string[]":
      if (!Array.isArray(value) || !strings(value)) return `${name} must be a list of strings`;
      return spec.pattern !== undefined &&
        !value.every((item) => matchesWhole(spec.pattern ?? "", String(item)))
        ? `every item of ${name} must match ${spec.pattern}`
        : null;
    case "number[]":
      return Array.isArray(value) && value.every((item) => typeof item === "number")
        ? null
        : `${name} must be a list of numbers`;
    case "json":
      return null;
  }
};

/**
 * An agent's output checked against its declared shape: types, patterns and required fields. The
 * compiler trusts a field with a pattern in argv, env and refs, so this is what makes that true.
 * Only declared fields come back; anything else the agent wrote is dropped.
 */
export const checkOutput = (
  shape: WorkflowOutputShape,
  output: JsonValue,
): Result.Result<{ readonly [field: string]: JsonValue }, string> => {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return Result.fail("the output must be a JSON object");
  }
  // Array.isArray does not narrow a readonly array out of the union; the check above did.
  const fields = output as { readonly [key: string]: JsonValue };
  const checked: Record<string, JsonValue> = {};
  for (const [name, spec] of Object.entries(shape)) {
    const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (value === undefined || value === null) {
      if (spec.optional === true) continue;
      return Result.fail(`${name} is missing`);
    }
    const error = fieldError(name, spec, value);
    if (error !== null) return Result.fail(error);
    checked[name] = value;
  }
  return Result.succeed(checked);
};
