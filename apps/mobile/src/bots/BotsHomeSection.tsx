import type { EnvironmentId } from "@t3tools/contracts";
import { Platform, View } from "react-native";

import { useHomeRouteVisible } from "../features/home/home-route-visibility";
import { ThreadListV2SectionDivider } from "../features/threads/thread-list-v2-items";
import { BotsList } from "./BotsList";
import { useBotsEnvironmentId } from "./state";

/**
 * The bots host whose bots the home thread list shows above its threads, or null. Android lists
 * bots in their own tab instead; iOS has no Bots tab yet, so they stay above its threads.
 */
export function useThreadListBotsEnvironmentId(): EnvironmentId | null {
  const environmentId = useBotsEnvironmentId();
  return Platform.OS === "android" ? null : environmentId;
}

/** The bots host's bots above the home thread list (iOS), as the Bots tab lists them. */
export function BotsHomeSection(props: { readonly environmentId: EnvironmentId }) {
  const visible = useHomeRouteVisible();
  return (
    <View>
      <ThreadListV2SectionDivider label="Bots" />
      <BotsList environmentId={props.environmentId} visible={visible} />
      <ThreadListV2SectionDivider label="Threads" />
    </View>
  );
}
