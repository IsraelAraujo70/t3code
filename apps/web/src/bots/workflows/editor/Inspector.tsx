import { findNode, renameNode, updateNode } from "@t3tools/client-runtime/workflows";
import {
  type EnvironmentId,
  type WorkflowDocument,
  WorkflowNode,
  WORKFLOW_NODE_ID_PATTERN,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Button } from "../../../components/ui/button";
import { InspectorField, NodeConfigForms } from "./NodeConfigForms";
import { applyFieldEdit, deleteInspectorNode, inspectorNodePath } from "./inspectorEdits";
import { TriggerInspector } from "./TriggerInspector";
import { WorkflowSettingsForm } from "./WorkflowSettingsForm";

const decodeNode = Schema.decodeUnknownOption(WorkflowNode);

export interface InspectorProps {
  readonly environmentId?: EnvironmentId;
  readonly document?: WorkflowDocument;
  readonly definition: WorkflowDefinition;
  readonly selected: string | null;
  readonly diagnostics: ReadonlyArray<WorkflowDiagnostic>;
  readonly readOnly: boolean;
  readonly onChange: (definition: WorkflowDefinition) => void;
  readonly onSelect: (id: string | null) => void;
}

/** Edits a selected node or the workflow settings through schema-validated commits. */
export function Inspector(props: InspectorProps) {
  const id = props.selected;
  const triggers = props.definition.triggers ?? {};
  const trigger = id !== null && Object.hasOwn(triggers, id) ? triggers[id] : undefined;
  if (id !== null && trigger) return <TriggerInspector {...props} id={id} trigger={trigger} />;
  const found = id === null ? null : findNode(props.definition, id);
  if (id === null || found === null)
    return (
      <WorkflowSettingsForm
        definition={props.definition}
        readOnly={props.readOnly}
        onChange={props.onChange}
      />
    );
  const node = found.node;
  const path = inspectorNodePath(props.definition, id);
  const diagnostics = props.diagnostics.filter(
    (item) =>
      path !== null &&
      (item.path === path || item.path.startsWith(`${path}.`) || item.path.startsWith(`${path}[`)),
  );
  return (
    <div className="space-y-3">
      <header>
        <h3 className="font-medium">
          {node.kind} · {id}
        </h3>
        <ul className="space-y-1 text-sm text-destructive" aria-label="Node diagnostics">
          {diagnostics.map((item) => (
            <li key={`${item.path}:${item.code}:${item.message}`}>
              {item.path} · {item.message}
            </li>
          ))}
        </ul>
      </header>
      <InspectorField
        key={`id:${id}`}
        spec={{ path: "id" }}
        value={id}
        readOnly={props.readOnly}
        onEdit={(_path, next) => {
          if (props.readOnly || next === id) return null;
          if (!WORKFLOW_NODE_ID_PATTERN.test(next))
            return "Invalid node id. Use lowercase letters, digits and underscores, starting with a letter.";
          if (findNode(props.definition, next) || Object.hasOwn(triggers, next))
            return "A node with this id already exists.";
          props.onChange(renameNode(props.definition, id, next));
          props.onSelect(next);
          return null;
        }}
      />
      <NodeConfigForms
        key={`config:${id}`}
        node={node}
        readOnly={props.readOnly}
        onEdit={(field, text, format) => {
          if (props.readOnly) return null;
          try {
            // Complete required siblings when the first retry/expiry field is entered.
            const base =
              field.startsWith("retry.") && node.retry === undefined
                ? { ...node, retry: { max: 0, on: [] } }
                : field.startsWith("expires.") && node.kind === "gate" && node.expires === undefined
                  ? { ...node, expires: { after: "1h", decision: "reject" } }
                  : node;
            const decoded = decodeNode(applyFieldEdit(base, field, text, format));
            if (Option.isNone(decoded)) return `Invalid value for ${field}. Check the node schema.`;
            props.onChange(updateNode(props.definition, id, decoded.value));
            return null;
          } catch {
            return `Invalid JSON for ${field}.`;
          }
        }}
      />
      <Button
        variant="destructive"
        size="sm"
        disabled={props.readOnly}
        onClick={() => {
          if (props.readOnly) return;
          props.onChange(deleteInspectorNode(props.definition, id));
          props.onSelect(null);
        }}
      >
        Delete node
      </Button>
    </div>
  );
}
