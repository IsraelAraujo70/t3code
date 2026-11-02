import type { WorkflowDefinition, WorkflowDiagnostic, WorkflowModelRef } from "@t3tools/contracts";
import {
  findNode,
  parseRunParam,
  toCanvasModel,
  updateNode,
} from "@t3tools/client-runtime/workflows";
import { compileWorkflow, DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";
import * as Result from "effect/Result";

/** Phone-editable fields keep raw text so invalid intermediate values remain visible. */
interface WorkflowEditDraft {
  readonly params: Readonly<Record<string, string>>;
  readonly cron: Readonly<Record<string, { readonly expr: string; readonly tz: string }>>;
  readonly agents: Readonly<
    Record<
      string,
      { readonly model: WorkflowModelRef; readonly prompt: string; readonly timeout: string }
    >
  >;
  readonly budget: { readonly steps: string; readonly wall: string; readonly tokens: string };
}

/** Snapshot editable values, resolving model aliases for the phone form. */
export function workflowEditDraft(definition: WorkflowDefinition): WorkflowEditDraft {
  const agents: Record<string, WorkflowEditDraft["agents"][string]> = {};
  for (const canvasNode of toCanvasModel(definition).nodes) {
    const node = findNode(definition, canvasNode.id)?.node;
    if (node?.kind !== "agent") continue;
    const model =
      typeof node.model === "string" ? definition.models?.[node.model.slice(1)] : node.model;
    if (model) agents[canvasNode.id] = { model, prompt: node.prompt, timeout: node.timeout ?? "" };
  }
  return {
    params: Object.fromEntries(
      Object.entries(definition.params ?? {}).map(([key, spec]) => [
        key,
        spec.default === undefined ? "" : String(spec.default),
      ]),
    ),
    cron: Object.fromEntries(
      Object.entries(definition.triggers ?? {}).flatMap(([id, trigger]) =>
        trigger.kind === "cron" ? [[id, { expr: trigger.expr, tz: trigger.tz }]] : [],
      ),
    ),
    agents,
    budget: {
      steps: String(definition.budget.steps),
      wall: definition.budget.wall,
      tokens: String(definition.budget.tokens),
    },
  };
}

/** Apply only phone fields, preserve topology, and compile on every edit before allowing save. */
export function compileWorkflowEdit(definition: WorkflowDefinition, draft: WorkflowEditDraft) {
  const diagnostics: WorkflowDiagnostic[] = [];
  let edited = definition;
  const params = { ...definition.params };
  for (const [key, text] of Object.entries(draft.params)) {
    const spec = definition.params?.[key];
    if (!spec) continue;
    if (text === "" && spec.default === undefined) continue;
    const parsed = parseRunParam(spec, text);
    if (parsed.ok) params[key] = { ...spec, default: parsed.value };
    else
      diagnostics.push({ path: `params.${key}.default`, code: "schema", message: parsed.message });
  }
  for (const [id, fields] of Object.entries(draft.agents)) {
    const node = findNode(edited, id)?.node;
    if (node?.kind !== "agent") continue;
    if (!fields.prompt.trim())
      diagnostics.push({
        path: `nodes.${id}.prompt`,
        code: "schema",
        message: "Prompt must not be empty.",
      });
    const { timeout: _timeout, ...rest } = node;
    edited = updateNode(edited, id, {
      ...rest,
      model:
        fields.model ===
        (typeof node.model === "string" ? definition.models?.[node.model.slice(1)] : node.model)
          ? node.model
          : fields.model,
      prompt: fields.prompt,
      ...(fields.timeout ? { timeout: fields.timeout } : {}),
    });
  }
  edited = {
    ...edited,
    ...(definition.params ? { params } : {}),
    triggers: Object.fromEntries(
      Object.entries(definition.triggers ?? {}).map(([id, trigger]) => [
        id,
        trigger.kind === "cron" && draft.cron[id] ? { ...trigger, ...draft.cron[id] } : trigger,
      ]),
    ),
    budget: {
      ...definition.budget,
      steps: Number(draft.budget.steps),
      wall: draft.budget.wall,
      tokens: Number(draft.budget.tokens),
    },
  };
  const result = compileWorkflow(edited, DEFAULT_HOST_LIMITS);
  if (Result.isFailure(result)) diagnostics.push(...result.failure);
  return { definition: edited, diagnostics };
}
