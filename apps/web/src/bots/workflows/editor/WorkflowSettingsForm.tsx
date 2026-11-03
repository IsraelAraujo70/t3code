import { WorkflowDefinition } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { InspectorField, type InspectorFieldSpec } from "./NodeConfigForms";
import { applyFieldEdit, fieldText, fieldValue } from "./inspectorEdits";

import { useBotDirectory, useBotsEnvironmentId } from "../../../state/bots";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "../../../components/ui/select";

const decodeDefinition = Schema.decodeUnknownOption(WorkflowDefinition);

const sections: ReadonlyArray<{
  readonly title: string;
  readonly fields: readonly InspectorFieldSpec[];
}> = [
  {
    title: "General",
    fields: [
      { path: "title", label: "Title" },
      { path: "description", label: "Description", multiline: true },
      { path: "home.project", label: "Home project" },
      { path: "concurrency", label: "Overlapping runs", choices: ["single", "queue", "parallel"] },
    ],
  },
  {
    title: "Limits per run",
    fields: [
      { path: "budget.steps", label: "Steps", format: "number" },
      { path: "budget.wall", label: "Active time" },
      { path: "budget.tokens", label: "Tokens", format: "number" },
      { path: "budget.usd", label: "Cost (USD)", format: "number" },
      { path: "fatigue.consecutiveFailures", label: "Suspend after failures", format: "number" },
    ],
  },
  {
    title: "Advanced",
    fields: [
      { path: "params", label: "Parameters", format: "json" },
      { path: "triggers", label: "Triggers", format: "json" },
      { path: "models", label: "Model aliases", format: "json" },
      { path: "workspaces", label: "Workspaces", format: "json" },
      { path: "card", label: "Kanban card", format: "json" },
      { path: "protect", label: "Protected refs", format: "json" },
    ],
  },
];

/** Validates the whole workflow before publishing a settings change. */
export function WorkflowSettingsForm(props: {
  readonly definition: WorkflowDefinition;
  readonly readOnly: boolean;
  readonly onChange: (definition: WorkflowDefinition) => void;
}) {
  const { directory } = useBotDirectory(useBotsEnvironmentId());
  const bots = directory?.bots ?? [];
  const selectedBot = props.definition.bot;
  return (
    <div className="space-y-5">
      <h3 className="font-medium text-sm">Workflow settings</h3>
      <div className="space-y-1">
        <label htmlFor="workflow-bot" className="flex flex-col gap-0.5 text-xs">
          <span className="font-medium text-muted-foreground">Works for bot</span>
          <span className="text-muted-foreground/70">
            Agent steps get the bot's tools; reports post in its chat.
          </span>
        </label>
        <Select
          value={selectedBot ?? ""}
          disabled={props.readOnly}
          onValueChange={(value) => {
            if (props.readOnly || value === null) return;
            const { bot: _bot, ...definition } = props.definition;
            const decoded = decodeDefinition(
              value === "" ? definition : { ...definition, bot: value },
            );
            if (Option.isSome(decoded)) props.onChange(decoded.value);
          }}
        >
          <SelectTrigger id="workflow-bot">
            <SelectValue>
              {selectedBot
                ? (bots.find((bot) => bot.id === selectedBot)?.name ?? selectedBot)
                : "None"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">None</SelectItem>
            {bots.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>
                {bot.name}
              </SelectItem>
            ))}
            {selectedBot && !bots.some((bot) => bot.id === selectedBot) ? (
              <SelectItem value={selectedBot}>{selectedBot}</SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
      </div>
      {sections.map((section) => (
        <fieldset key={section.title} className="space-y-3">
          <legend className="mb-2 font-medium text-muted-foreground/80 text-2xs uppercase tracking-wide">
            {section.title}
          </legend>
          {section.fields.map((spec) => {
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
        </fieldset>
      ))}
    </div>
  );
}
