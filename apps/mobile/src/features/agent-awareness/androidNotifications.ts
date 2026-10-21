import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  // Fork (friend): direct bot pushes have an independent native gate.
  configureBots?(scheme: string, enabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(deviceId, userId, appScheme(), ongoingEnabled);
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}

// Fork (friend): bot notifications do not require a relay identity.
/** Configures native bot delivery, including when the JS bridge is stopped. */
export function configureAndroidBotNotifications(enabled: boolean): void {
  native?.configureBots?.(appScheme(), enabled);
}
