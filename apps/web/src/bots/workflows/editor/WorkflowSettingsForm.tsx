import { WorkflowDefinition } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { InspectorField, type InspectorFieldSpec } from "./NodeConfigForms";
import { applyFieldEdit, fieldText, fieldValue } from "./inspectorEdits";

const decodeDefinition = Schema.decodeUnknownOption(WorkflowDefinition);

const fields: readonly InspectorFieldSpec[] = [
  { path: "title" },
  { path: "description", multiline: true },
  { path: "home.project" },
  { path: "concurrency", choices: ["single", "queue", "parallel"] },
  { path: "budget.steps", format: "number" },
  { path: "budget.wall" },
  { path: "budget.tokens", format: "number" },
  { path: "budget.usd", format: "number" },
  { path: "fatigue.consecutiveFailures", format: "number" },
  ...["params", "triggers", "models", "workspaces", "card", "protect"].map((path) => ({
    path,
    format: "json" as const,
  })),
];

/** Validates the whole workflow before publishing a settings change. */
export function WorkflowSettingsForm(props: {
  readonly definition: WorkflowDefinition;
  readonly readOnly: boolean;
  readonly onChange: (definition: WorkflowDefinition) => void;
}) {
  return (
    <div className="space-y-3">
      <h3 className="font-medium">Workflow settings</h3>
      {fields.map((spec) => {
        const value = fieldValue(props.definition, spec.path);
        return (
          <InspectorField
            key={`${spec.path}:${fieldText(value, spec.format ?? "text")}`}
            spec={spec}
            value={value}
            readOnly={props.readOnly}
            onEdit={(path, text, format) => {
              if (props.readOnly) return null;
              try {
                const decoded = decodeDefinition(
                  applyFieldEdit(props.definition, path, text, format),
                );
                if (Option.isNone(decoded))
                  return `Invalid value for ${path}. Check the workflow schema.`;
                props.onChange(decoded.value);
                return null;
              } catch {
                return `Invalid JSON for ${path}.`;
              }
            }}
          />
        );
      })}
    </div>
  );
}
