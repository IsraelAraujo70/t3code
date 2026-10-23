import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { registerPushDevice, unregisterPushDevice } from "./api";
import type { Pairing } from "./pairing";
import { loadPushToken, savePushToken } from "./storage";

/** Also the plugin's `defaultChannel`, so the server's FCM messages land here too. */
const CHANNEL_ID = "respostas";

/** Call once at startup, before any permission request: Android 13 only prompts once a channel exists. */
export async function setUpNotifications(): Promise<void> {
  // While the app is open, the live stream shows an in-app banner instead.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Respostas",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

/**
 * Asks for permission and registers this phone for push. Without FCM configured (no
 * google-services file in the build) the token call fails; the app still works, without push.
 */
export async function registerForPush(pairing: Pairing): Promise<void> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return;
  let token: string;
  try {
    const devicePushToken = await Notifications.getDevicePushTokenAsync();
    if (devicePushToken.type !== "android" || typeof devicePushToken.data !== "string") return;
    token = devicePushToken.data;
  } catch (error) {
    console.warn("Push indisponível neste build:", error);
    return;
  }
  const label = (Device.modelName ?? "Android").slice(0, 128);
  await registerPushDevice(pairing, { token, label });
  await savePushToken(token);
}

/** Best effort: a phone that cannot reach the server still gets logged out. */
export async function unregisterForPush(pairing: Pairing): Promise<void> {
  const token = await loadPushToken();
  if (token === null) return;
  await unregisterPushDevice(pairing, { token }).catch(() => undefined);
}

export async function showReplyNotification(input: {
  readonly botId: string;
  readonly title: string;
  readonly body: string;
}): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: { title: input.title, body: input.body, data: { botId: input.botId } },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  });
}

function botIdOf(response: Notifications.NotificationResponse): string | null {
  const { content, trigger } = response.notification.request;
  const fromContent = content.data?.botId;
  if (typeof fromContent === "string") return fromContent;
  // An FCM message that Android displayed by itself keeps its data on the remote message.
  if (trigger !== null && "remoteMessage" in trigger) {
    const fromRemote = trigger.remoteMessage?.data?.botId;
    if (typeof fromRemote === "string") return fromRemote;
  }
  return null;
}

/** Calls `onOpen` with the bot of every tapped notification, including the one that launched the app. */
export function listenForNotificationTaps(onOpen: (botId: string) => void): () => void {
  const handled = new Set<string>();
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (response === null) return;
    const id = response.notification.request.identifier;
    if (handled.has(id)) return;
    handled.add(id);
    const botId = botIdOf(response);
    if (botId !== null) onOpen(botId);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  Notifications.getLastNotificationResponseAsync()
    .then(handle)
    .catch(() => undefined);
  return () => subscription.remove();
}
