import { TriggerConfigForms } from "./TriggerConfigForms";
import { useAtomCommand } from "../../../state/use-atom-command";
import { workflowsEnvironment } from "../state";
import { randomUUID } from "../../../lib/utils";
import { Switch } from "../../../components/ui/switch";
import { WebhookTriggerPanel } from "./WebhookTriggerPanel";
import {
  findNode,
  renameNode,
  CANVAS_NODE_STYLES,
  canvasTriggerType,
} from "@t3tools/client-runtime/workflows";
import { WorkflowTrigger, WORKFLOW_NODE_ID_PATTERN } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Button } from "../../../components/ui/button";
import { InspectorField } from "./NodeConfigForms";
import { applyFieldEdit } from "./inspectorEdits";
import type { InspectorProps } from "./Inspector";

const decodeTrigger = Schema.decodeUnknownOption(WorkflowTrigger);

/** Edits trigger configuration through the authoritative trigger schema. */
export function TriggerInspector(props: InspectorProps & { id: string; trigger: WorkflowTrigger }) {
  const { id, trigger, definition } = props;
  const setEnabled = useAtomCommand(workflowsEnvironment.setEnabled);
  const summary = props.document?.triggers.find((item) => item.id === id);
  return (
    <div className="space-y-3">
      <h3>
        {CANVAS_NODE_STYLES[canvasTriggerType(trigger.kind)].label} · {id}
      </h3>
      <InspectorField
        key={`id:${id}`}
        spec={{ path: "id" }}
        value={id}
        readOnly={props.readOnly}
        onEdit={(_path, next) => {
          if (!WORKFLOW_NODE_ID_PATTERN.test(next)) return "Invalid trigger id.";
          if (next === id) return null;
          if (findNode(definition, next) || definition.triggers?.[next])
            return "This id already exists.";
          props.onChange(renameNode(definition, id, next));
          props.onSelect(next);
          return null;
        }}
      />
      {props.diagnostics
        .filter((item) => item.path === `triggers.${id}` || item.path.startsWith(`triggers.${id}.`))
        .map((item) => (
          <p key={`${item.path}:${item.code}`}>{item.message}</p>
        ))}
      {summary && trigger.kind !== "manual" && (
        <div>
          <Switch
            aria-label="On"
            checked={summary.enabled}
            disabled={props.readOnly}
            onCheckedChange={(enabled) => {
              if (props.environmentId && props.document)
                void setEnabled({
                  environmentId: props.environmentId,
                  input: {
                    workflowId: props.document.workflowId,
                    triggerId: id,
                    enabled,
                    clientRequestId: randomUUID(),
                  },
                });
            }}
          />
        </div>
      )}
      {trigger.kind === "webhook" && props.environmentId && props.document && (
        <WebhookTriggerPanel
          environmentId={props.environmentId}
          document={props.document}
          triggerId={id}
        />
      )}
      <TriggerConfigForms
        id={id}
        trigger={trigger}
        readOnly={props.readOnly}
        onEdit={(path, text, format) => {
          try {
            const decoded = decodeTrigger(applyFieldEdit(trigger, path, text, format));
            if (Option.isNone(decoded)) return `Invalid value for ${path}.`;
            props.onChange({
              ...definition,
              triggers: { ...definition.triggers, [id]: decoded.value },
            });
            return null;
          } catch {
            return `Invalid JSON for ${path}.`;
          }
        }}
      />
      {trigger.kind === "manual" && (
        <p>
          Run now opens the form with this workflow's params:{" "}
          {Object.keys(definition.params ?? {}).join(", ")}
        </p>
      )}
      {trigger.kind === "bot" && (
        <p>
          Bots run this only when it is on, and a bot without Manage bots only in a turn you
          started.
        </p>
      )}
      <Button
        variant="destructive"
        size="sm"
        disabled={props.readOnly}
        onClick={() => {
          const triggers = { ...definition.triggers };
          delete triggers[id];
          props.onChange({ ...definition, triggers });
          props.onSelect(null);
        }}
      >
        Delete trigger
      </Button>
    </div>
  );
}
