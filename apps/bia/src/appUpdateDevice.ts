import {
  createSelfUpdate,
  readEmbeddedBuild,
  type SelfUpdateSnapshot,
} from "@t3tools/client-runtime/app-self-update";
import type { MobileUpdateBuild } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";
import { Alert, AppState, Platform } from "react-native";
import ReactNativeBlobUtil from "react-native-blob-util";

import { authorizationHeader } from "./api";
import { APP_UPDATE_ROUTES, parseAppUpdateInfo } from "./appUpdate";
import type { Pairing } from "./pairing";

const APK_MIME = "application/vnd.android.package-archive";
const DOWNLOAD_DIR = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/app-update`;
const INSTALL_HINT_KEY = "bia.appUpdate.installHint";
const INFO_TIMEOUT_MS = 20_000;

const apkPath = (build: MobileUpdateBuild) => `${DOWNLOAD_DIR}/bia-${build.commit}.apk`;

/** The server Bia is paired with; set while she is paired. */
let target: Pairing | null = null;

/** Explains Android's one-time "install unknown apps" step before it first appears. */
async function confirmFirstInstall(): Promise<boolean> {
  if ((await SecureStore.getItemAsync(INSTALL_HINT_KEY).catch(() => null)) !== null) return true;
  const proceed = await new Promise<boolean>((resolve) =>
    Alert.alert(
      "Atualizar o app",
      'Só na primeira vez, o celular vai pedir permissão para este app instalar a atualização. Toque em "Configurações", ligue "Permitir desta fonte" e volte. Se nada acontecer, toque em Atualizar de novo.',
      [
        { text: "Agora não", style: "cancel", onPress: () => resolve(false) },
        { text: "Continuar", onPress: () => resolve(true) },
      ],
      { cancelable: false },
    ),
  );
  if (proceed) await SecureStore.setItemAsync(INSTALL_HINT_KEY, "1").catch(() => {});
  return proceed;
}

/** The app's single self-update (Android only). */
export const appUpdate = createSelfUpdate({
  embedded: Platform.OS === "android" ? readEmbeddedBuild(Constants.expoConfig?.extra) : null,
  notConnectedMessage: "Sem conexão com o servidor.",
  fetchInfo: async () => {
    const pairing = target;
    if (pairing === null) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INFO_TIMEOUT_MS);
    try {
      const response = await fetch(pairing.server + APP_UPDATE_ROUTES.info, {
        headers: { accept: "application/json", authorization: authorizationHeader(pairing) },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`o servidor respondeu ${response.status}.`);
      return parseAppUpdateInfo(await response.json());
    } finally {
      clearTimeout(timer);
    }
  },
  confirmInstall: confirmFirstInstall,
  // Android asks once for permission to install apps and then drops the install; the next tap
  // reuses this file.
  downloaded: async (build) => {
    const path = apkPath(build);
    return (await ReactNativeBlobUtil.fs.exists(path)) ? path : null;
  },
  download: async (build, onProgress) => {
    const pairing = target;
    if (pairing === null) throw new Error("sem conexão com o servidor.");
    // Older downloads go first: only the APK being installed stays in the cache.
    if (await ReactNativeBlobUtil.fs.exists(DOWNLOAD_DIR)) {
      await ReactNativeBlobUtil.fs.unlink(DOWNLOAD_DIR);
    }
    await ReactNativeBlobUtil.fs.mkdir(DOWNLOAD_DIR);
    const path = apkPath(build);
    const url = `${pairing.server}${APP_UPDATE_ROUTES.apk}?commit=${build.commit}`;
    const response = await ReactNativeBlobUtil.config({ path, overwrite: true })
      .fetch("GET", url, { authorization: authorizationHeader(pairing) })
      .progress({ interval: 250 }, (received, total) =>
        onProgress(Number(total) > 0 ? Number(received) / Number(total) : null),
      );
    const status = response.info().status;
    if (status === 409) throw new Error("saiu uma versão mais nova. Verifique de novo.");
    if (status !== 200) throw new Error(`o servidor respondeu ${status}.`);
    return path;
  },
  inspect: async (path) => {
    const [sha256, stat] = await Promise.all([
      ReactNativeBlobUtil.fs.hash(path, "sha256"),
      ReactNativeBlobUtil.fs.stat(path),
    ]);
    return { sha256: sha256.toLowerCase(), size: Number(stat.size) };
  },
  install: async (path) => {
    await ReactNativeBlobUtil.android.actionViewIntent(path, APK_MIME);
  },
  now: Date.now,
});

export function useAppUpdate(): SelfUpdateSnapshot {
  return useSyncExternalStore(appUpdate.subscribe, appUpdate.getSnapshot);
}

/**
 * Checks the paired server when the pairing starts and again whenever the app returns to the
 * foreground, at most every `CHECK_INTERVAL_MS`. Mounted once while paired.
 */
export function useAppUpdateChecks(pairing: Pairing): void {
  const enabled = appUpdate.getSnapshot().embedded !== null;

  useEffect(() => {
    if (!enabled) return;
    target = pairing;
    void appUpdate.check("launch");
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void appUpdate.check("foreground");
    });
    return () => {
      subscription.remove();
      if (target === pairing) target = null;
    };
  }, [enabled, pairing]);
}
