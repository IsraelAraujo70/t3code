import { fromCanvasModel, toCanvasModel } from "@t3tools/client-runtime/workflows";
import type {
  EnvironmentId,
  WorkflowDocument,
  WorkflowSaveInput,
  WorkflowSaveResult,
  WorkflowDiagnostic,
  WorkflowDefinition,
} from "@t3tools/contracts";
import { compileWorkflow, DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";
import * as Result from "effect/Result";
import { useReducer, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { ToggleGroup, Toggle } from "../../../components/ui/toggle-group";
import { LazyWorkflowCanvas } from "../canvas/LazyWorkflowCanvas";
import { WorkflowToneBadge } from "../WorkflowStatusBadge";
import { ConflictBanner } from "./ConflictBanner";
import { initialEditorState, reducer } from "./editorState";
import { Inspector } from "./Inspector";
import { SourceTab } from "./SourceTab";
import { WorkflowPalette } from "./WorkflowPalette";

const tabs = ["Canvas", "Source", "Runs", "Metrics", "Ledger", "History"] as const;
type Tab = (typeof tabs)[number];
interface WorkflowEditorViewProps {
  environmentId: EnvironmentId;
  document: WorkflowDocument;
  save: (
    input: WorkflowSaveInput,
  ) => Promise<{ ok: true; result: WorkflowSaveResult } | { ok: false; message: string }>;
  extraTabs?: Partial<Record<Tab, ReactNode>>;
}

/** Edits one document with explicit revision-conflict resolution. */
export function WorkflowEditorView(props: WorkflowEditorViewProps) {
  const [state, dispatch] = useReducer(reducer, props.document, initialEditorState);
  const [observed, setObserved] = useState(props.document);
  if (observed !== props.document) {
    setObserved(props.document);
    dispatch({ type: "documentArrived", document: props.document });
  }
  const [tab, setTab] = useState<Tab>("Canvas");
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(`Edit ${props.document.workflowId}`);
  const [error, setError] = useState<string | null>(null);
  const [serverDiagnostics, setServerDiagnostics] = useState<ReadonlyArray<WorkflowDiagnostic>>([]);
  const current = state.draft ?? state.base.definition;
  const model = current === null ? null : toCanvasModel(current);
  const compiled = state.draft === null ? null : compileWorkflow(state.draft, DEFAULT_HOST_LIMITS);
  const diagnostics = [
    ...(compiled === null
      ? state.base.diagnostics
      : Result.isFailure(compiled)
        ? compiled.failure
        : []),
    ...serverDiagnostics,
  ];

  const edit = (definition: WorkflowDefinition) => {
    if (saving) return;
    dispatch({ type: "edited", definition });
    setServerDiagnostics([]);
  };
  const save = async (input: WorkflowSaveInput) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const response = await props.save(input).catch((cause: unknown) => ({
      ok: false as const,
      message: cause instanceof Error ? cause.message : "Could not save workflow.",
    }));
    setSaving(false);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    switch (response.result._tag) {
      case "Saved":
        dispatch({ type: "saved" });
        setServerDiagnostics([]);
        break;
      case "Conflict":
        dispatch({ type: "conflictReturned", current: response.result.current });
        break;
      case "Invalid":
        setServerDiagnostics(response.result.diagnostics);
        break;
    }
  };
  return (
    <div className="flex min-h-full flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{current?.title ?? state.base.workflowId}</h2>
        <WorkflowToneBadge
          tone={
            diagnostics.length === 0 && (state.draft !== null || state.base.valid)
              ? "success"
              : "danger"
          }
        >
          {diagnostics.length === 0 && (state.draft !== null || state.base.valid)
            ? "Valid"
            : "Invalid"}
        </WorkflowToneBadge>
        {state.draft !== null ? (
          <WorkflowToneBadge tone="warning">Unsaved</WorkflowToneBadge>
        ) : null}
        {state.base.dirty ? (
          <WorkflowToneBadge tone="warning">Edited by hand</WorkflowToneBadge>
        ) : null}
        <WorkflowToneBadge tone={state.base.enabled ? "info" : "muted"}>
          {state.base.enabled ? "Enabled" : "Disabled"}
        </WorkflowToneBadge>
        <div className="ml-auto flex items-center gap-2">
          <Input
            aria-label="Commit message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            disabled={saving}
          />
          <Button
            size="sm"
            disabled={state.draft === null || saving}
            onClick={() => {
              if (state.draft === null) return;
              void save({
                workflowId: state.base.workflowId,
                baseRevision: state.base.revision,
                message,
                definition: state.draft,
                ...(state.draft.canvas === undefined ? {} : { canvas: state.draft.canvas }),
              });
            }}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>
      <div className="overflow-x-auto">
        <ToggleGroup
          value={[tab]}
          onValueChange={(values) => {
            const next = tabs.find((item) => item === values[0]);
            if (next) setTab(next);
          }}
          aria-label="Workflow tabs"
        >
          {tabs.map((item) => (
            <Toggle key={item} value={item}>
              {item}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <ConflictBanner
        state={state}
        disabled={saving}
        onMerge={() => {
          dispatch({ type: "merge" });
          setServerDiagnostics([]);
        }}
        onReload={() => {
          dispatch({ type: "reload" });
          setServerDiagnostics([]);
          setSelected(null);
        }}
        onOverwrite={() => dispatch({ type: "overwrite" })}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {diagnostics.length > 0 ? (
        <ul aria-label="Diagnostics" className="space-y-1 text-sm text-destructive">
          {diagnostics.map((diagnostic) => {
            const node = /^nodes\.([^.]+)/.exec(diagnostic.path)?.[1];
            return (
              <li key={`${diagnostic.path}:${diagnostic.code}:${diagnostic.message}`}>
                {node ? (
                  <Button size="xs" variant="ghost" onClick={() => setSelected(node)}>
                    {diagnostic.path}
                  </Button>
                ) : (
                  <span>{diagnostic.path}</span>
                )}{" "}
                · {diagnostic.code} · {diagnostic.message}
              </li>
            );
          })}
        </ul>
      ) : null}
      {tab === "Canvas" ? (
        current === null || model === null ? (
          <p>This file does not compile. Fix it in the Source tab.</p>
        ) : (
          <div className="flex min-h-96 flex-1 flex-col gap-3 lg:flex-row">
            <div className="relative min-h-96 min-w-0 flex-1">
              <LazyWorkflowCanvas
                model={model}
                mode="edit"
                onSelectNode={setSelected}
                onChange={(next) => {
                  if (saving) return;
                  const converted = fromCanvasModel(next, current);
                  edit(converted.definition);
                }}
                toolbar={
                  <WorkflowPalette
                    definition={current}
                    disabled={saving}
                    onAdd={(definition, id) => {
                      edit(definition);
                      setSelected(id);
                    }}
                  />
                }
              />
            </div>
            <aside className="w-full shrink-0 border-border lg:w-72 lg:border-l lg:pl-3">
              <fieldset disabled={saving}>
                <Inspector
                  definition={current}
                  selected={selected}
                  diagnostics={diagnostics}
                  readOnly={false}
                  onChange={edit}
                  onSelect={setSelected}
                />
              </fieldset>
            </aside>
          </div>
        )
      ) : tab === "Source" ? (
        <SourceTab
          document={state.base}
          hasDraft={state.draft !== null}
          saving={saving}
          onSave={(source, commitMessage) =>
            void save({
              workflowId: state.base.workflowId,
              baseRevision: state.base.revision,
              source,
              message: commitMessage,
            })
          }
        />
      ) : (
        (props.extraTabs?.[tab] ?? <p>{tab}</p>)
      )}
    </div>
  );
}
