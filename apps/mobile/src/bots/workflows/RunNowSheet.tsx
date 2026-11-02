import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Switch, TextInput } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, WorkflowDefinition, WorkflowId } from "@t3tools/contracts";
import { defaultRunParams, parseRunParam } from "@t3tools/client-runtime/workflows";
import * as Crypto from "expo-crypto";
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
    const result = await start({
      environmentId,
      input: { workflowId, params, clientRequestId: Crypto.randomUUID() },
    });
    if (result._tag === "Success") {
      onClose();
      navigation.navigate("BotsWorkflowRun", { environmentId, runId: result.value.runId });
    }
    setPending(false);
  };
  return (
    <Modal visible onRequestClose={onClose} animationType="slide">
      <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }}>
        <Text>Run now</Text>
        {Object.entries(definition.params ?? {}).map(([key, spec]) => (
          <ScrollView key={key}>
            <Text>{key}</Text>
            {spec.type === "boolean" ? (
              <Switch
                accessibilityLabel={key}
                value={values[key] === "true"}
                onValueChange={(value) => setValues({ ...values, [key]: String(value) })}
              />
            ) : (
              <TextInput
                accessibilityLabel={key}
                value={values[key]}
                keyboardType={spec.type === "number" ? "numeric" : "default"}
                onChangeText={(value) => setValues({ ...values, [key]: value })}
              />
            )}
            {errors[key] && <Text>{errors[key]}</Text>}
          </ScrollView>
        ))}
        <Pressable disabled={pending || !canRun} onPress={() => void submit()}>
          <Text>{pending ? "Starting…" : "Start run"}</Text>
        </Pressable>
        <Pressable disabled={pending} onPress={onClose}>
          <Text>Cancel</Text>
        </Pressable>
      </ScrollView>
    </Modal>
  );
}
