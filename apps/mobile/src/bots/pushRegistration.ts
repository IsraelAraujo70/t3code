import { useAtomValue } from "@effect/atom-react";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";
import { AppState, Platform } from "react-native";

import { configureAndroidBotNotifications } from "../features/agent-awareness/androidNotifications";
import { requestAgentNotificationPermission } from "../features/agent-awareness/notificationPermissions";
import { runtime } from "../lib/runtime";
import { mobilePreferencesAtom } from "../state/preferences";
import { useAtomCommand } from "../state/use-atom-command";
import { useRemoteEnvironmentRuntime } from "../state/use-remote-environment-registry";
import { createBotPushRegistration } from "./pushRegistration.logic";
import { botsEnvironment, useBotsEnvironmentId } from "./state";

/** Maintains direct FCM registration independently of cloud account registration. */
export function BotPushRegistration() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const environmentId = useBotsEnvironmentId();
  const connection = useRemoteEnvironmentRuntime(environmentId);
  const register = useAtomCommand(botsEnvironment.registerPushDevice);
  const unregister = useAtomCommand(botsEnvironment.unregisterPushDevice);
  const controller = useMemo(
    () =>
      createBotPushRegistration({
        configure: configureAndroidBotNotifications,
        permission: async () =>
          (await runtime.runPromise(requestAgentNotificationPermission)).type === "granted",
        readToken: async () => {
          const token = await Notifications.getDevicePushTokenAsync();
          return token.type === "android" && typeof token.data === "string" && token.data.trim()
            ? token.data.trim()
            : null;
        },
        register: async ({ environmentId, token }) => {
          const result = await register({
            environmentId,
            input: { token, label: Device.modelName ?? "Android" },
          });
          if (result._tag === "Failure") throw new Error("Bot push registration failed");
        },
        unregister: async ({ environmentId, token }) => {
          const result = await unregister({ environmentId, input: { token } });
          if (result._tag === "Failure") throw new Error("Bot push unregistration failed");
        },
        log: (error) => console.warn("[bot-push] registration failed", error),
        now: Date.now,
      }),
    [register, unregister],
  );
  const enabled = AsyncResult.isSuccess(preferences)
    ? preferences.value.botNotificationsEnabled !== false
    : null;
  const connectedId = connection?.connectionState === "connected" ? environmentId : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Registers or unregisters this device push token as the preference and connection change.
  useEffect(() => {
    if (Platform.OS !== "android" || enabled === null) return;
    void controller.update(enabled, connectedId);
  }, [controller, enabled, connectedId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns native foreground and push-token listeners for the registration controller.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void controller.refresh("foreground");
    });
    const tokens = Notifications.addPushTokenListener((token) => {
      if (token.type === "android" && typeof token.data === "string" && token.data.trim()) {
        void controller.refresh("token", token.data.trim());
      }
    });
    return () => {
      appState.remove();
      tokens.remove();
      controller.dispose();
    };
  }, [controller]);
  return null;
}
