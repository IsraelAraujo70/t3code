import {
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  type EnvironmentId,
  MOBILE_UPDATE_APK_PATH,
  MOBILE_UPDATE_PATH,
  type MobileUpdateBuild,
  MobileUpdateInfo,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import ReactNativeBlobUtil from "react-native-blob-util";

import * as Dialog from "../components/ui/Dialog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";
import { useRemoteEnvironmentRuntime } from "../state/use-remote-environment-registry";
import { createSelfUpdate, readEmbeddedBuild } from "./selfUpdate.logic";
import { useBotsEnvironmentId } from "./state";

const APK_MIME = "application/vnd.android.package-archive";
const DOWNLOAD_DIR = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/friend-update`;
const INSTALL_HINT_KEY = "t3code.friend.self-update.install-hint.v1";
const decodeInfo = Schema.decodeUnknownPromise(MobileUpdateInfo);

const apkPath = (build: MobileUpdateBuild) => `${DOWNLOAD_DIR}/t3code-friend-${build.commit}.apk`;

/** The bots host publishes the APK; set while its connection is up. */
let target: EnvironmentId | null = null;

// The update routes take the same short-lived `wsTicket` as the Computer stream.
const updateAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: MOBILE_UPDATE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile-self-update-access:${environmentId}`)),
);

/** `path` on the environment with a fresh ticket. */
async function updateUrl(
  environmentId: EnvironmentId,
  path: string,
  params: Readonly<Record<string, string>> = {},
): Promise<string> {
  const atom = updateAccessAtom(environmentId);
  appAtomRegistry.refresh(atom);
  const access = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
    ),
  );
  const url = new URL(access.httpBase);
  url.pathname = path;
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return withDeviceHubQuery(url.toString(), access);
}

/** Explains Android's one-time "install unknown apps" step before it first appears. */
async function confirmFirstInstall(): Promise<boolean> {
  if ((await SecureStore.getItemAsync(INSTALL_HINT_KEY).catch(() => null)) !== null) return true;
  const proceed = await new Promise<boolean>((resolve) =>
    Dialog.alert(
      "Instalar a atualização",
      'Na primeira vez o Android pede para permitir que o T3 Code instale apps. Toque em Configurações, ative "Permitir desta fonte" e volte. Se o instalador não reaparecer, toque em Atualizar de novo: o APK já baixado é aproveitado.',
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

/** The app's single self-update (friend preview APK on Android). */
export const selfUpdate = createSelfUpdate({
  embedded: Platform.OS === "android" ? readEmbeddedBuild(Constants.expoConfig?.extra) : null,
  fetchInfo: async () => {
    if (target === null) return null;
    const response = await fetch(await updateUrl(target, MOBILE_UPDATE_PATH), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`o servidor respondeu ${response.status}.`);
    return decodeInfo(await response.json());
  },
  confirmInstall: confirmFirstInstall,
  downloaded: async (build) => {
    const path = apkPath(build);
    return (await ReactNativeBlobUtil.fs.exists(path)) ? path : null;
  },
  download: async (build, onProgress) => {
    if (target === null) throw new Error("o servidor do T3 não está conectado.");
    const url = await updateUrl(target, MOBILE_UPDATE_APK_PATH, { commit: build.commit });
    // Older downloads go first: only the APK being installed stays in the cache.
    if (await ReactNativeBlobUtil.fs.exists(DOWNLOAD_DIR)) {
      await ReactNativeBlobUtil.fs.unlink(DOWNLOAD_DIR);
    }
    await ReactNativeBlobUtil.fs.mkdir(DOWNLOAD_DIR);
    const path = apkPath(build);
    const response = await ReactNativeBlobUtil.config({ path, overwrite: true })
      .fetch("GET", url)
      .progress({ interval: 250 }, (received, total) =>
        onProgress(Number(total) > 0 ? Number(received) / Number(total) : null),
      );
    const status = response.info().status;
    if (status === 409) throw new Error("outra versão foi publicada. Verifique de novo.");
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

/** Observes the self-update. */
export function useSelfUpdate() {
  return useSyncExternalStore(selfUpdate.subscribe, selfUpdate.getSnapshot);
}

/**
 * Checks the bots host once its connection is up, and again when the app returns to the
 * foreground (at most every `CHECK_INTERVAL_MS`). Mounted once at the app root.
 */
export function useSelfUpdateChecks() {
  const environmentId = useBotsEnvironmentId();
  const connection = useRemoteEnvironmentRuntime(environmentId);
  const connectedId = connection?.connectionState === "connected" ? environmentId : null;
  const enabled = selfUpdate.getSnapshot().embedded !== null;

  useEffect(() => {
    if (!enabled) return;
    target = connectedId;
    if (connectedId !== null) void selfUpdate.check("launch");
  }, [enabled, connectedId]);

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void selfUpdate.check("foreground");
    });
    return () => subscription.remove();
  }, [enabled]);
}
