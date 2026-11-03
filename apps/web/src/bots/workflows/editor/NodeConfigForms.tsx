import type { WorkflowNode } from "@t3tools/contracts";
import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { fieldText, fieldValue, type EditFormat } from "./inspectorEdits";

export interface InspectorFieldSpec {
  readonly path: string;
  /** Words for the field; the YAML path then shows beside it. Without one the path is the label. */
  readonly label?: string;
  readonly format?: EditFormat;
  readonly multiline?: boolean;
  readonly choices?: readonly string[];
  readonly toggle?: boolean;
}

interface FieldProps {
  readonly spec: InspectorFieldSpec;
  readonly value: unknown;
  readonly readOnly: boolean;
  readonly onEdit: (path: string, text: string, format: EditFormat) => string | null;
}

/** Keeps incomplete text local until blur or Enter, including rejected edits. */
export function InspectorField({ spec, value, readOnly, onEdit }: FieldProps) {
  const id = useId();
  const name = spec.label ?? spec.path;
  const format = spec.format ?? "text";
  const initial = fieldText(value, format);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const commit = (next: string) => {
    if (readOnly || next === initial) {
      setError(null);
      return;
    }
    setError(onEdit(spec.path, next, format));
  };
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-muted-foreground">{name}</span>
        {spec.label === undefined ? null : (
          <code className="truncate text-2xs text-muted-foreground/70">{spec.path}</code>
        )}
      </label>
      {spec.toggle ? (
        <div>
          <Switch
            id={id}
            aria-label={name}
            disabled={readOnly}
            checked={value === true}
            onCheckedChange={(checked) => setError(onEdit(spec.path, String(checked), "json"))}
          />
        </div>
      ) : spec.choices ? (
        <Select
          value={text}
          disabled={readOnly}
          onValueChange={(next) => {
            if (next !== null) {
              setText(next);
              commit(next);
            }
          }}
        >
          <SelectTrigger id={id} aria-label={name}>
            <SelectValue>{text === "" ? "Default" : text}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">Default / unset</SelectItem>
            {spec.choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : spec.multiline || format === "json" || format === "lines" ? (
        <div className={format === "json" ? "font-mono" : undefined}>
          <Textarea
            id={id}
            aria-label={name}
            value={text}
            disabled={readOnly}
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => commit(text)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </div>
      ) : (
        <Input
          id={id}
          aria-label={name}
          value={text}
          disabled={readOnly}
          type={format === "number" ? "number" : "text"}
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => commit(text)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const common: readonly InspectorFieldSpec[] = [
  { path: "title" },
  { path: "timeout" },
  { path: "when" },
  { path: "continueOnFail", toggle: true },
  { path: "retry.max", format: "number" },
  { path: "retry.on", format: "commas" },
  { path: "retry.backoff" },
  { path: "retry", format: "json" },
  { path: "join", choices: ["all", "any"] },
  { path: "once", format: "json" },
];

const fields = {
  agent: [
    { path: "prompt", multiline: true },
    { path: "workspace", format: "workspace", multiline: true },
    { path: "access", choices: ["read", "write"] },
    { path: "thread" },
    { path: "askIsrael", toggle: true },
    { path: "tokenReservation", format: "number" },
    { path: "output", format: "json" },
    { path: "accept", format: "json" },
  ],
  command: [
    { path: "argv", format: "lines" },
    { path: "cwd", format: "workspace", multiline: true },
    { path: "heavy", toggle: true },
    { path: "selfSerializing", toggle: true },
    { path: "replay", choices: ["safe", "never"] },
    { path: "parse", choices: ["none", "json", "json-last-line"] },
    { path: "check" },
    { path: "tokensFrom" },
    { path: "tokenReservation", format: "number" },
    { path: "env", format: "json" },
    { path: "output", format: "json" },
  ],
  gate: [
    { path: "ask", multiline: true },
    { path: "options", format: "commas" },
    { path: "expires.after" },
    { path: "expires.decision" },
    { path: "expires", format: "json" },
  ],
  output: [
    {
      path: "status",
      choices: [
        "no_change",
        "ready_for_review",
        "no_gain",
        "rejected",
        "checks_failed",
        "blocked",
        "proposals",
      ],
    },
    { path: "report", multiline: true },
    { path: "value", format: "json" },
    { path: "handoff", multiline: true },
    { path: "pullRequest", format: "json" },
    { path: "promote", format: "json" },
    { path: "notify", toggle: true },
    { path: "postToBot", toggle: true },
  ],
  branch: [{ path: "cases", format: "json" }, { path: "else" }],
  call: [{ path: "workflow" }, { path: "params", format: "json" }],
  map: [
    { path: "items" },
    { path: "as" },
    { path: "maxItems", format: "number" },
    { path: "concurrency", format: "number" },
    { path: "body", format: "json" },
    { path: "collect", format: "json" },
  ],
  loop: [{ path: "until" }, { path: "max", format: "number" }, { path: "body", format: "json" }],
  hillclimb: [
    { path: "workspace", format: "json" },
    { path: "ledger" },
    { path: "generator", format: "json" },
    { path: "build", format: "json" },
    { path: "measure", format: "json" },
    { path: "objective", format: "json" },
    { path: "keep" },
    { path: "target" },
    { path: "confirmWhen" },
    { path: "plateau", format: "json" },
    { path: "budget", format: "json" },
  ],
  arena: [
    { path: "task", multiline: true },
    { path: "artifact" },
    { path: "runners", format: "json" },
    { path: "minCandidates", format: "number" },
    { path: "judge", format: "json" },
    { path: "rubric", format: "json" },
    { path: "lead", format: "json" },
    { path: "verify", format: "json" },
    { path: "maxReruns", format: "number" },
    { path: "workspace", format: "json" },
  ],
  graph: [
    { path: "goal", multiline: true },
    { path: "lead", format: "json" },
    { path: "leaf", format: "json" },
    { path: "workspace", format: "json" },
    { path: "finalChecks", format: "json" },
    { path: "reworkCap", format: "number" },
    { path: "maxLeaves", format: "number" },
    { path: "maxParallel", format: "number" },
  ],
  interrogate: [
    { path: "target", format: "json" },
    { path: "intent", multiline: true },
    { path: "mode", choices: ["loop", "panel"] },
    { path: "reviewers", format: "json" },
    { path: "lead", format: "json" },
    { path: "checks", format: "json" },
    { path: "rounds", format: "number" },
  ],
} satisfies Record<WorkflowNode["kind"], readonly InspectorFieldSpec[]>;

/** Renders every schema field for the selected kind, with local input buffers. */
export function NodeConfigForms(props: {
  readonly node: WorkflowNode;
  readonly readOnly: boolean;
  readonly onEdit: FieldProps["onEdit"];
}) {
  const node = props.node;
  const modelFields: readonly InspectorFieldSpec[] =
    node.kind !== "agent"
      ? []
      : typeof node.model === "string"
        ? [{ path: "model" }]
        : [
            { path: "model.provider", choices: ["codex", "claude"] },
            { path: "model.model" },
            { path: "model.effort", choices: ["low", "medium", "high", "xhigh", "max"] },
          ];
  return (
    <div className="space-y-3">
      {node.kind === "agent" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={props.readOnly}
          onClick={() =>
            props.onEdit(
              "model",
              JSON.stringify(
                typeof node.model === "string"
                  ? { provider: "codex", model: "gpt-6.1-sol" }
                  : "$lead",
              ),
              "json",
            )
          }
        >
          {typeof node.model === "string" ? "Use inline model" : "Use model reference"}
        </Button>
      ) : null}
      {[...common, ...modelFields, ...fields[node.kind]].map((spec) => {
        const value = fieldValue(node, spec.path);
        return (
          <InspectorField
            key={`${spec.path}:${fieldText(value, spec.format ?? "text")}`}
            spec={spec}
            value={value}
            readOnly={props.readOnly}
            onEdit={props.onEdit}
          />
        );
      })}
      <p className="text-xs text-muted-foreground">
        Text commits on blur or Enter. Multiline fields use Ctrl+Enter. Workspace and cwd accept a
        name or a JSON object with project and readOnly.
      </p>
    </div>
  );
}
