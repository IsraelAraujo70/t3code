import {
  defaultRunParams,
  parseRunParam,
  workflowRunHref,
  type WorkflowParamValue,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotsField, commandFailureMessage } from "../botsSettingsShared";
import { useWorkflowDocument, workflowsEnvironment } from "./state";

/** Starts a run with a form generated from the workflow's params, then opens the run. */
export function RunNowDialog(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
  onClose: () => void;
}) {
  const document = useWorkflowDocument(props.environmentId, props.workflowId);
  const params = document.data?.definition?.params;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run {document.data?.definition?.title ?? props.workflowId}</DialogTitle>
          <DialogDescription>
            The run uses the version saved now, with these parameters.
          </DialogDescription>
        </DialogHeader>
        {document.data === null ? (
          <DialogPanel>
            <p className="text-sm text-muted-foreground">{document.error ?? "Loading…"}</p>
          </DialogPanel>
        ) : document.data.definition === null ? (
          <DialogPanel>
            <p className="text-sm text-destructive">
              This workflow has errors. Fix them in the editor before running it.
            </p>
          </DialogPanel>
        ) : (
          <RunNowForm
            key={document.data.revision}
            environmentId={props.environmentId}
            workflowId={props.workflowId}
            params={params ?? {}}
            onClose={props.onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function RunNowForm(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
  params: NonNullable<Parameters<typeof defaultRunParams>[0]>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const runStart = useAtomCommand(workflowsEnvironment.runStart, { label: "workflow run" });
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(defaultRunParams(props.params)).map(([name, value]) => [name, String(value)]),
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = Object.entries(props.params).map(
    ([name, spec]) => [name, spec, parseRunParam(spec, texts[name] ?? "")] as const,
  );
  const valid = parsed.every(([, , result]) => result.ok);

  const submit = async () => {
    const values: Record<string, WorkflowParamValue> = {};
    for (const [name, , result] of parsed) {
      if (!result.ok) return;
      values[name] = result.value;
    }
    setPending(true);
    setError(null);
    const result = await runStart({
      environmentId: props.environmentId,
      input: {
        workflowId: props.workflowId,
        params: values,
        clientRequestId: randomUUID(),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(commandFailureMessage(result));
      return;
    }
    props.onClose();
    void navigate({ href: workflowRunHref(props.environmentId, result.value.runId) });
  };

  return (
    <>
      <DialogPanel>
        <fieldset disabled={pending} className="space-y-4">
          {parsed.length === 0 ? (
            <p className="text-sm text-muted-foreground">This workflow takes no parameters.</p>
          ) : null}
          {parsed.map(([name, spec, result]) =>
            spec.type === "boolean" ? (
              <BotsField key={name} label={name} hint={spec.description ?? ""}>
                <Switch
                  aria-label={name}
                  checked={texts[name] === "true"}
                  onCheckedChange={(checked) =>
                    setTexts((current) => ({ ...current, [name]: String(checked) }))
                  }
                />
              </BotsField>
            ) : (
              <BotsField
                key={name}
                label={name}
                hint={spec.description ?? ""}
                htmlFor={`run-param-${name}`}
              >
                <Input
                  id={`run-param-${name}`}
                  inputMode={spec.type === "number" ? "decimal" : undefined}
                  value={texts[name] ?? ""}
                  onChange={(event) =>
                    setTexts((current) => ({ ...current, [name]: event.target.value }))
                  }
                />
                {result.ok ? null : <p className="text-xs text-destructive">{result.message}</p>}
              </BotsField>
            ),
          )}
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
          Cancel
        </DialogClose>
        <Button size="sm" disabled={!valid || pending} onClick={() => void submit()}>
          Run now
        </Button>
      </DialogFooter>
    </>
  );
}
