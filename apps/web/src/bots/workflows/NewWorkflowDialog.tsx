import {
  WorkflowId,
  type EnvironmentId,
  type WorkflowDefinition,
  type WorkflowSaveResult,
  type WorkflowTemplateSummary,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotsField, commandFailureMessage } from "../botsSettingsShared";
import { workflowsEnvironment } from "./state";

const decodeWorkflowId = Schema.decodeUnknownOption(WorkflowId);

/** Creates a workflow, blank or from a template, and opens it in the editor. */
export function NewWorkflowDialog(props: {
  environmentId: EnvironmentId;
  /** A template to copy; null starts a blank workflow. */
  template: WorkflowTemplateSummary | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const save = useAtomCommand(workflowsEnvironment.save, { label: "workflow create" });
  const fromTemplate = useAtomCommand(workflowsEnvironment.fromTemplate, {
    label: "workflow from template",
  });
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === props.environmentId &&
      project.isScratch !== true &&
      !project.archivedAt,
  );
  const [id, setId] = useState(props.template?.templateId ?? "");
  const [title, setTitle] = useState(props.template?.title ?? "");
  const [project, setProject] = useState<string | null>(projects[0]?.title ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowId = Option.getOrNull(decodeWorkflowId(id.trim()));
  const valid =
    workflowId !== null && (props.template !== null || (title.trim() !== "" && project !== null));

  const settle = (result: WorkflowSaveResult) => {
    switch (result._tag) {
      case "Saved":
        props.onClose();
        void navigate({
          to: "/workflows/$environmentId/$workflowId",
          params: { environmentId: props.environmentId, workflowId: result.workflowId },
        });
        return;
      case "Conflict":
        setError(`A workflow named ${result.workflowId} already exists.`);
        return;
      case "Invalid":
        setError(result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
        return;
    }
  };

  const submit = async () => {
    if (workflowId === null) return;
    setPending(true);
    setError(null);
    const result =
      props.template !== null
        ? await fromTemplate({
            environmentId: props.environmentId,
            input: { templateId: props.template.templateId, workflowId },
          })
        : await save({
            environmentId: props.environmentId,
            input: {
              message: `Create ${workflowId}`,
              definition: blankDefinition(workflowId, title.trim(), project ?? ""),
            },
          });
    setPending(false);
    if (result._tag === "Failure") {
      setError(commandFailureMessage(result));
      return;
    }
    settle(result.value);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {props.template === null ? "New workflow" : `New from ${props.template.title}`}
          </DialogTitle>
          <DialogDescription>
            {props.template === null
              ? "A workflow is a YAML file in the bots host's definitions repository."
              : (props.template.description ?? "A copy of the template you can edit.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending} className="space-y-4">
            <BotsField label="Id" hint="lowercase, digits and -" htmlFor="workflow-id">
              <Input
                id="workflow-id"
                placeholder="weekly-upstream-merge"
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
              {id.trim() !== "" && workflowId === null ? (
                <p className="text-xs text-destructive">
                  Start with a letter; use lowercase letters, digits and dashes.
                </p>
              ) : null}
            </BotsField>
            {props.template === null ? (
              <>
                <BotsField label="Title" htmlFor="workflow-title">
                  <Input
                    id="workflow-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </BotsField>
                <BotsField label="Home project">
                  <Select value={project} onValueChange={(value) => setProject(value)}>
                    <SelectTrigger aria-label="Home project" size="sm">
                      <SelectValue>{project ?? "Choose a project"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((entry) => (
                        <SelectItem key={entry.id} value={entry.title}>
                          {entry.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </BotsField>
              </>
            ) : null}
            {error === null ? null : (
              <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p>
            )}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!valid || pending} onClick={() => void submit()}>
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The smallest definition the compiler accepts: no nodes yet, conservative budget. */
function blankDefinition(id: WorkflowId, title: string, project: string): WorkflowDefinition {
  return {
    schema: "t3.workflow/v1",
    id,
    title,
    home: { project },
    budget: { steps: 50, wall: "2h", tokens: 2_000_000 },
    fatigue: { consecutiveFailures: 3 },
    nodes: {},
    edges: [],
  };
}
