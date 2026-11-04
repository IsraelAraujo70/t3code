/** Model references of a definition: families, aliases and `$name` resolution. */
import * as Result from "effect/Result";

import type { WorkflowModelRef, WorkflowModelUse } from "@t3tools/contracts";

import type { ModelFamily } from "./types.ts";

/** The family is the provider's: claude → "claude", codex → "gpt". */
export const modelFamily = (ref: WorkflowModelRef): ModelFamily => {
  return ref.provider === "claude" ? "claude" : "gpt";
};

/** True for a family alias instead of an exact id: opus, sonnet, haiku, fable, any case, with or without a `[…]` suffix. */
export const isModelAlias = (model: string): boolean => {
  return /^(opus|sonnet|haiku|fable)(\[[^\]]*\])?$/i.test(model.trim());
};

/** `$params.<name>`: the param whose value picks the model; null for any other use. */
export const modelParamOf = (use: WorkflowModelUse): string | null =>
  typeof use === "string" && use.startsWith("$params.") ? use.slice("$params.".length) : null;

/** The `models` entry a param value names: the entry of that name, else the one with that model id. */
export const modelForValue = (
  value: string,
  models: { readonly [name: string]: WorkflowModelRef } | undefined,
): Result.Result<WorkflowModelRef, string> => {
  if (models !== undefined && Object.hasOwn(models, value)) return Result.succeed(models[value]!);
  const byId = Object.values(models ?? {}).filter((ref) => ref.model === value);
  if (byId.length === 1) return Result.succeed(byId[0]!);
  return Result.fail(
    byId.length === 0
      ? `"${value}" names no entry of models (by name or model id)`
      : `"${value}" is the model of several models entries; name the entry instead`,
  );
};

/**
 * A ref as is, `$name` looked up in `models`, or `$params.<name>` resolved through the run's
 * params; the error names the missing reference.
 */
export const resolveModelUse = (
  use: WorkflowModelUse,
  models: { readonly [name: string]: WorkflowModelRef } | undefined,
  params?: { readonly [name: string]: unknown },
): Result.Result<WorkflowModelRef, string> => {
  if (typeof use !== "string") return Result.succeed(use);
  const param = modelParamOf(use);
  if (param !== null) {
    const value = params !== undefined && Object.hasOwn(params, param) ? params[param] : undefined;
    return typeof value === "string"
      ? modelForValue(value, models)
      : Result.fail(`${use} has no string value in this run`);
  }
  const name = use.slice(1);
  const ref = models !== undefined && Object.hasOwn(models, name) ? models[name] : undefined;
  return ref ? Result.succeed(ref) : Result.fail(`Missing ${use}; add it under models`);
};
