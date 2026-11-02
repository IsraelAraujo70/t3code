import type { WorkflowDocument } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";

export interface SourceTabProps {
  readonly document: WorkflowDocument;
  readonly hasDraft: boolean;
  readonly saving: boolean;
  readonly onSave: (source: string, message: string) => void;
}

/** Shows disk source independently of unsaved canvas changes. */
export function SourceTab(props: SourceTabProps) {
  return (
    <SourceEditor key={`${props.document.workflowId}:${props.document.revision}`} {...props} />
  );
}

function SourceEditor(props: SourceTabProps) {
  const [text, setText] = useState(props.document.source);
  const [message, setMessage] = useState(`Edit ${props.document.workflowId} source`);
  return (
    <div className="space-y-3">
      {props.hasDraft ? (
        <p role="status">Your canvas edits are not in this text; save or discard them first.</p>
      ) : null}
      {props.document.dirty ? <p role="status">The file on disk has uncommitted changes.</p> : null}
      {!props.document.valid ? (
        <p role="alert">The file on disk is invalid. Fix the source before running it.</p>
      ) : null}
      <ul aria-label="Source diagnostics" className="space-y-1 text-sm text-destructive">
        {props.document.diagnostics.map((item) => (
          <li key={`${item.path}:${item.code}:${item.message}`}>
            {item.path} · {item.code} · {item.message}
          </li>
        ))}
      </ul>
      <div className="font-mono">
        <Textarea
          aria-label="Workflow source"
          value={text}
          disabled={props.saving}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Comments are not kept; use description for notes.
      </p>
      <Input
        aria-label="Source commit message"
        value={message}
        disabled={props.saving}
        onChange={(event) => setMessage(event.target.value)}
      />
      <Button
        disabled={props.hasDraft || props.saving || message.trim() === ""}
        onClick={() => {
          if (!props.hasDraft && !props.saving) props.onSave(text, message);
        }}
      >
        {props.saving ? "Saving…" : "Save source"}
      </Button>
    </div>
  );
}
