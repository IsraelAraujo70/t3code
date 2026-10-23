import * as SecureStore from "expo-secure-store";

import { formatPairing, parsePairing, type Pairing } from "./pairing";

const PAIRING_KEY = "bia.pairing";
const PUSH_TOKEN_KEY = "bia.pushToken";

export async function loadPairing(): Promise<Pairing | null> {
  const stored = await SecureStore.getItemAsync(PAIRING_KEY);
  // Stored in the QR format so one parser validates both.
  return stored === null ? null : parsePairing(stored);
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, formatPairing(pairing));
}

export function loadPushToken(): Promise<string | null> {
  return SecureStore.getItemAsync(PUSH_TOKEN_KEY);
}

export async function savePushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
}

export async function clearStorage(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(PAIRING_KEY),
    SecureStore.deleteItemAsync(PUSH_TOKEN_KEY),
  ]);
}
