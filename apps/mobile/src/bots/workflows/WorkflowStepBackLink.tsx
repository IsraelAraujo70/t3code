import { useNavigation } from "@react-navigation/native";
import { isWorkflowStepThreadId, parseWorkflowStepThreadId } from "@t3tools/contracts";
import { Chip } from "../../components/ui/Chip";

/** Link a step thread directly to its parent run without fetching the server. */
export function workflowStepHeaderLink(environmentId: string, threadId: string) {
  if (!isWorkflowStepThreadId(threadId)) return undefined;
  const parsed = parseWorkflowStepThreadId(threadId);
  return parsed ? (
    <WorkflowStepBackLink environmentId={environmentId} runId={parsed.runId} />
  ) : undefined;
}

function WorkflowStepBackLink({ environmentId, runId }: { environmentId: string; runId: string }) {
  const navigation = useNavigation();
  return (
    <Chip
      label="Run"
      icon="arrow.left"
      size="small"
      onPress={() => navigation.navigate("BotsWorkflowRun", { environmentId, runId })}
    />
  );
}
