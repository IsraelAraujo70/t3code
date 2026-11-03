import {
  fromCanvasModel,
  toCanvasModel,
  withTriggerStates,
} from "@t3tools/client-runtime/workflows";
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
import { cn } from "../../../lib/utils";
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
  const [inspectorFocused, setInspectorFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(`Edit ${props.document.workflowId}`);
  const [error, setError] = useState<string | null>(null);
  // Unsaved Source tab text and the revision it started from; null shows the file on disk.
  const [source, setSource] = useState<{
    readonly text: string;
    readonly revision: WorkflowDocument["revision"];
  } | null>(null);
  const [serverDiagnostics, setServerDiagnostics] = useState<ReadonlyArray<WorkflowDiagnostic>>([]);
  const current = state.draft ?? state.base.definition;
  const model =
    current === null
      ? null
      : withTriggerStates(toCanvasModel(current), {
          enabled: new Map(
            props.document.triggers
              .filter((trigger) => trigger.kind !== "manual")
              .map((trigger) => [trigger.id, trigger.enabled]),
          ),
        });
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
        if ("source" in input) setSource(null);
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
    // A definite height on wide screens; with only min-h-full the canvas row sizes to the inspector.
    <div className={cn("flex min-h-full flex-col gap-3 p-4", tab === "Canvas" && "lg:h-full")}>
      {/* Badges follow Save in the DOM: one appearing on blur must not move Save under the pointer. */}
      <header className="flex items-center gap-2">
        <div className="min-w-0 shrink overflow-x-auto">
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
        <div className="order-2 ml-auto flex shrink-0 items-center gap-2">
          <div className="hidden w-56 md:block">
            <Input
              aria-label="Commit message"
              placeholder="Describe the change"
              size="sm"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={saving}
            />
          </div>
          <Button
            size="xs"
            // A focused inspector field commits on blur, which pressing Save causes; keep the
            // button live so that same press saves the committed draft.
            disabled={(state.draft === null && !inspectorFocused) || saving}
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
        <div className="order-1 flex shrink-0 items-center gap-2">
          {!(diagnostics.length === 0 && (state.draft !== null || state.base.valid)) ? (
            <WorkflowToneBadge tone="danger">
              {`${diagnostics.length || 1} error${diagnostics.length > 1 ? "s" : ""}`}
            </WorkflowToneBadge>
          ) : null}
          {state.draft !== null ? (
            <WorkflowToneBadge tone="warning">Unsaved</WorkflowToneBadge>
          ) : null}
          {state.base.dirty ? (
            <WorkflowToneBadge tone="warning">Edited by hand</WorkflowToneBadge>
          ) : null}
        </div>
      </header>
      <ConflictBanner
        state={state}
        disabled={saving}
        onMerge={() => {
          dispatch({ type: "merge" });
          setServerDiagnostics([]);
        }}
        sourceDraft={source !== null}
        onReload={() => {
          setSource(null);
          dispatch({ type: "reload" });
          setServerDiagnostics([]);
          setSelected(null);
        }}
        onOverwrite={() => {
          const current = state.conflict?.current;
          if (source !== null && current !== undefined)
            setSource({ text: source.text, revision: current.revision });
          dispatch({ type: "overwrite" });
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {diagnostics.length > 0 ? (
        <ul
          aria-label="Diagnostics"
          className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        >
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
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
            This file does not compile. Fix it in the Source tab.
          </p>
        ) : (
          <div className="flex min-h-96 flex-1 flex-col gap-3 lg:flex-row">
            <div className="flex min-h-96 min-w-0 flex-1 flex-col gap-2">
              <WorkflowPalette
                definition={current}
                disabled={saving}
                onAdd={(definition, id) => {
                  edit(definition);
                  setSelected(id);
                }}
              />
              <div className="relative min-h-96 flex-1">
                <LazyWorkflowCanvas
                  model={model}
                  mode="edit"
                  onSelectNode={setSelected}
                  onChange={(next) => {
                    if (saving) return;
                    const converted = fromCanvasModel(next, current);
                    edit(converted.definition);
                  }}
                />
              </div>
            </div>
            <aside
              className="w-full shrink-0 border-border lg:w-80 lg:overflow-y-auto lg:border-l lg:pl-4"
              onFocus={() => setInspectorFocused(true)}
              onBlur={() => setInspectorFocused(false)}
            >
              <fieldset disabled={saving}>
                <Inspector
                  environmentId={props.environmentId}
                  document={props.document}
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
          text={source?.text ?? state.base.source}
          stale={source !== null && source.revision !== state.base.revision}
          onTextChange={(text) =>
            setSource({ text, revision: source?.revision ?? state.base.revision })
          }
          onSave={(text, commitMessage) =>
            void save({
              workflowId: state.base.workflowId,
              baseRevision: source?.revision ?? state.base.revision,
              source: text,
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
