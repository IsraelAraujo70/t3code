import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, WorkflowDefinition, WorkflowId } from "@t3tools/contracts";
import { defaultRunParams, parseRunParam } from "@t3tools/client-runtime/workflows";
import * as Crypto from "expo-crypto";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { Sheet } from "../../components/ui/Sheet";
import { WorkflowEditField } from "./WorkflowEditField";
import { AppText as Text } from "../../components/ui/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "./state";

/** Parameter form validates every field before starting one idempotent run. */
export function RunNowSheet({
  environmentId,
  workflowId,
  definition,
  onClose,
}: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
  definition: WorkflowDefinition;
  onClose: () => void;
}) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      Object.entries(defaultRunParams(definition.params)).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const canRun = useAtomValue(workflowsEnvironment.runStart.permissionAtom(environmentId));
  const start = useAtomCommand(workflowsEnvironment.runStart);
  const navigation = useNavigation();
  const submit = async () => {
    const params: Record<string, string | number | boolean> = {};
    const failures: Record<string, string> = {};
    for (const [key, spec] of Object.entries(definition.params ?? {})) {
      const parsed = parseRunParam(spec, values[key] ?? "");
      if (parsed.ok) params[key] = parsed.value;
      else failures[key] = parsed.message;
    }
    setErrors(failures);
    if (Object.keys(failures).length) return;
    setPending(true);
    setFailed(false);
    const result = await start({
      environmentId,
      input: { workflowId, params, clientRequestId: Crypto.randomUUID() },
    });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      navigation.navigate("BotsWorkflowRun", { environmentId, runId: result.value.runId });
    } else setFailed(true);
  };
  const params = Object.entries(definition.params ?? {});
  return (
    <Sheet title={`Run ${definition.title}`} onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4 p-4 pb-10" keyboardShouldPersistTaps="handled">
        <Text className="text-sm text-foreground-muted">
          {params.length === 0
            ? "This workflow takes no parameters. The run starts right away."
            : "Each field starts at its default."}
        </Text>
        {params.map(([key, spec]) =>
          spec.type === "boolean" ? (
            <ListToggleRow
              key={key}
              label={key}
              description={spec.description}
              value={values[key] === "true"}
              onValueChange={(value) => setValues({ ...values, [key]: String(value) })}
            />
          ) : (
            <View key={key} className="gap-1">
              <WorkflowEditField
                label={key}
                value={values[key] ?? ""}
                onChange={(value) => setValues({ ...values, [key]: value })}
              />
              {spec.description ? (
                <Text className="text-xs text-foreground-muted">{spec.description}</Text>
              ) : null}
              {errors[key] ? <Notice tone="danger" message={errors[key]} /> : null}
            </View>
          ),
        )}
        {failed ? <Notice tone="danger" message="The run did not start. Try again." /> : null}
        <Button
          label="Start run"
          tone="primary"
          fullWidth
          loading={pending}
          disabled={!canRun}
          onPress={() => void submit()}
        />
      </ScrollView>
    </Sheet>
  );
}
