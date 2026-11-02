import { Button } from "../../../components/ui/button";
import type { EditorState } from "./editorState";

/** Explicit resolution of remote edits, including files that no longer compile. */
export function ConflictBanner(props: {
  state: EditorState;
  disabled: boolean;
  onMerge: () => void;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  const current = props.state.conflict?.current ?? props.state.remote;
  return (
    <div className="space-y-2" aria-live="polite">
      {current !== null && props.state.draft !== null ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded border border-border p-3 text-sm"
        >
          {current.definition === null ? (
            <>
              <p>
                The file on disk was changed by hand and does not compile. Overwrite it with your
                version, or discard your edits.
              </p>
              <Button size="sm" disabled={props.disabled} onClick={props.onOverwrite}>
                Overwrite
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={props.disabled}
                onClick={props.onReload}
              >
                Discard
              </Button>
            </>
          ) : (
            <>
              <p>
                Changed by {current.updatedBy ?? "someone"}
                {props.state.conflict ? " while you edited." : "."}
              </p>
              <Button size="sm" disabled={props.disabled} onClick={props.onMerge}>
                Merge
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={props.disabled}
                onClick={props.onReload}
              >
                Reload
              </Button>
            </>
          )}
        </div>
      ) : null}
      {props.state.mergedConflicts.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Kept your version of: {props.state.mergedConflicts.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
