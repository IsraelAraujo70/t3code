import { mergeDocuments } from "@t3tools/client-runtime/workflows";
import type { WorkflowDefinition, WorkflowDocument } from "@t3tools/contracts";

export interface EditorState {
  readonly base: WorkflowDocument;
  readonly draft: WorkflowDefinition | null;
  readonly remote: WorkflowDocument | null;
  readonly conflict: {
    readonly current: WorkflowDocument;
    readonly conflicts: ReadonlyArray<string>;
  } | null;
  readonly mergedConflicts: ReadonlyArray<string>;
}
type EditorEvent =
  | { readonly type: "documentArrived"; readonly document: WorkflowDocument }
  | { readonly type: "edited"; readonly definition: WorkflowDefinition }
  | { readonly type: "conflictReturned"; readonly current: WorkflowDocument }
  | { readonly type: "saved" | "merge" | "reload" | "overwrite" };

/** Starts an editing session from the authoritative file revision. */
export function initialEditorState(base: WorkflowDocument): EditorState {
  return { base, draft: null, remote: null, conflict: null, mergedConflicts: [] };
}

/** Preserves local edits until the user explicitly resolves a revision conflict. */
export function reducer(state: EditorState, event: EditorEvent): EditorState {
  switch (event.type) {
    case "documentArrived":
      return state.draft === null
        ? initialEditorState(event.document)
        : event.document.revision === state.base.revision
          ? state
          : { ...state, remote: event.document };
    case "edited":
      return { ...state, draft: event.definition };
    case "saved":
      return {
        ...state,
        base: state.remote ?? state.base,
        draft: null,
        remote: null,
        conflict: null,
        mergedConflicts: [],
      };
    case "conflictReturned":
      return { ...state, conflict: { current: event.current, conflicts: [] } };
    case "reload":
      return initialEditorState(state.conflict?.current ?? state.remote ?? state.base);
    case "overwrite":
      return {
        ...state,
        base: state.conflict?.current ?? state.remote ?? state.base,
        conflict: null,
        remote: null,
      };
    case "merge": {
      const current = state.conflict?.current ?? state.remote;
      if (!current?.definition || !state.base.definition || !state.draft) return state;
      const result = mergeDocuments(state.base.definition, state.draft, current.definition);
      return {
        base: current,
        draft: result.merged,
        remote: null,
        conflict: null,
        mergedConflicts: result.conflicts,
      };
    }
  }
}
