import type { WorkflowGateView } from "@t3tools/contracts";
import { gateReasonOf } from "@t3tools/client-runtime/workflows";
import { gateAskMarkdown } from "@t3tools/shared/workflows";
import { useState } from "react";
import { Linking, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";

/** The full ask as readable markdown. */
export function GateAskMarkdown({ ask }: { ask: string }) {
  const styles = useMarkdownPreviewStyles();
  return (
    <SelectableMarkdownText
      markdown={gateAskMarkdown(ask)}
      textStyle={styles.nativeTextStyle}
      onLinkPress={(href) => void Linking.openURL(href)}
    />
  );
}

/** A gate's short reason, with the full ask behind "Show more". */
export function GateAsk({ gate }: { gate: WorkflowGateView }) {
  const [open, setOpen] = useState(false);
  const reason = gateReasonOf(gate);
  const more = reason !== gate.ask.replace(/\s+/g, " ").trim();
  return (
    <View className="gap-2">
      <Text>{reason}</Text>
      {more && open ? <GateAskMarkdown ask={gate.ask} /> : null}
      {more ? (
        <View className="flex-row">
          <ControlPill
            label={open ? "Show less" : "Show more"}
            variant="pill"
            onPress={() => setOpen(!open)}
          />
        </View>
      ) : null}
    </View>
  );
}
