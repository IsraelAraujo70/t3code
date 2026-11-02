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

/** A ref as is, or `$name` looked up in `models`; the error names the missing reference. */
export const resolveModelUse = (
  use: WorkflowModelUse,
  models: { readonly [name: string]: WorkflowModelRef } | undefined,
): Result.Result<WorkflowModelRef, string> => {
  if (typeof use !== "string") return Result.succeed(use);
  const name = use.slice(1);
  const ref = models !== undefined && Object.hasOwn(models, name) ? models[name] : undefined;
  return ref ? Result.succeed(ref) : Result.fail(`Missing ${use}; add it under models`);
};
