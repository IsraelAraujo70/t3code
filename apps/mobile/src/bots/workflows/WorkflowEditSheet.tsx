import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  WorkflowDefinition,
  WorkflowDocument,
  WorkflowModelRef,
} from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { Sheet } from "../../components/ui/Sheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkflowEditField } from "./WorkflowEditField";
import { compileWorkflowEdit, workflowEditDraft } from "./workflowEdit.logic";
import { workflowsEnvironment } from "./state";

const efforts: ReadonlyArray<WorkflowModelRef["effort"]> = [
  undefined,
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Edit a pinned document revision; live document updates never overwrite an in-progress form. */
export function WorkflowEditSheet({
  environmentId,
  document,
  definition,
  onClose,
}: {
  environmentId: EnvironmentId;
  document: WorkflowDocument;
  definition: WorkflowDefinition;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => workflowEditDraft(definition));
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const allowed = useAtomValue(workflowsEnvironment.save.permissionAtom(environmentId));
  const save = useAtomCommand(workflowsEnvironment.save);
  const compiled = compileWorkflowEdit(definition, draft);
  const change = (next: typeof draft) => {
    setDraft(next);
    if (!conflict) setServerError(null);
  };
  const submit = async () => {
    if (compiled.diagnostics.length || conflict || pending) return;
    setPending(true);
    const result = await save({
      environmentId,
      input: {
        workflowId: document.workflowId,
        baseRevision: document.revision,
        message: "Edit from phone",
        definition: compiled.definition,
      },
    });
    setPending(false);
    if (result._tag !== "Success") return;
    if (result.value._tag === "Saved") onClose();
    else if (result.value._tag === "Conflict") {
      setConflict(true);
      setServerError("Changed elsewhere; reopen to edit the new version.");
    } else
      setServerError(result.value.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
  };
  return (
    <Sheet title="Edit workflow" onClose={onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-4 pb-10"
      >
        {Object.entries(draft.params).map(([key, value]) => (
          <WorkflowEditField
            key={key}
            label={`${key} default (${definition.params?.[key]?.type})`}
            value={value}
            onChange={(text) => change({ ...draft, params: { ...draft.params, [key]: text } })}
          />
        ))}
        {Object.entries(draft.cron).map(([key, cron]) => (
          <ListSection key={key} title={`Cron · ${key}`}>
            <View className="gap-3 p-3">
              {(["expr", "tz"] as const).map((field) => (
                <WorkflowEditField
                  key={field}
                  label={field === "expr" ? "Cron expression" : "Time zone"}
                  value={cron[field]}
                  onChange={(value) =>
                    change({
                      ...draft,
                      cron: { ...draft.cron, [key]: { ...cron, [field]: value } },
                    })
                  }
                />
              ))}
            </View>
          </ListSection>
        ))}
        {Object.entries(draft.agents).map(([key, agent]) => {
          const set = (next: typeof agent) =>
            change({ ...draft, agents: { ...draft.agents, [key]: next } });
          return (
            <ListSection title={`Agent · ${key}`} key={key}>
              <View className="gap-3 p-3">
                <View className="flex-row gap-2">
                  {(["codex", "claude"] as const).map((provider) => (
                    <Chip
                      key={provider}
                      label={provider}
                      selected={agent.model.provider === provider}
                      onPress={() => set({ ...agent, model: { ...agent.model, provider } })}
                    />
                  ))}
                </View>
                <WorkflowEditField
                  label="Model"
                  value={agent.model.model}
                  onChange={(model) => set({ ...agent, model: { ...agent.model, model } })}
                />
                <Text>Effort</Text>
                <View className="flex-row flex-wrap gap-2">
                  {efforts.map((effort) => (
                    <Chip
                      key={effort ?? "default"}
                      label={effort ?? "Default"}
                      selected={effort === agent.model.effort}
                      onPress={() => {
                        const { effort: _effort, ...model } = agent.model;
                        set({ ...agent, model: { ...model, ...(effort ? { effort } : {}) } });
                      }}
                    />
                  ))}
                </View>
                <WorkflowEditField
                  label="Prompt"
                  multiline
                  value={agent.prompt}
                  onChange={(prompt) => set({ ...agent, prompt })}
                />
                <WorkflowEditField
                  label="Timeout (empty uses default)"
                  value={agent.timeout}
                  onChange={(timeout) => set({ ...agent, timeout })}
                />
              </View>
            </ListSection>
          );
        })}
        <ListSection title="Run budget">
          <View className="gap-3 p-3">
            {(["steps", "wall", "tokens"] as const).map((key) => (
              <WorkflowEditField
                key={key}
                label={key}
                value={draft.budget[key]}
                onChange={(value) =>
                  change({ ...draft, budget: { ...draft.budget, [key]: value } })
                }
              />
            ))}
          </View>
        </ListSection>
        {compiled.diagnostics.map((d) => (
          <Notice
            key={`${d.path}/${d.code}/${d.message}`}
            tone="danger"
            message={`${d.path}: ${d.message}`}
          />
        ))}
        {serverError && <Notice tone="danger" message={serverError} />}
        <ControlPill
          label={pending ? "Saving…" : "Save"}
          variant="primary"
          disabled={pending || !allowed || conflict || compiled.diagnostics.length > 0}
          onPress={() => void submit()}
        />
      </ScrollView>
    </Sheet>
  );
}
