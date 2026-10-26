/**
 * The fork's Mac app updating itself from the bots host, like the friend APK
 * (`apps/mobile/src/bots/selfUpdate.ts`): the renderer checks the host's published build with the
 * connection's credentials, and the main process (`apps/desktop/src/friend`) downloads, verifies
 * and installs it. Only a packaged fork Mac build exposes `window.friendDesktopSelfUpdate`;
 * everywhere else this is null.
 */
import {
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { createSelfUpdate } from "@t3tools/client-runtime/app-self-update";
import {
  DESKTOP_UPDATE_PATH,
  DESKTOP_UPDATE_ZIP_PATH,
  type EnvironmentId,
  type FriendDesktopSelfUpdateBridge,
  MobileUpdateInfo,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

const decodeInfo = Schema.decodeUnknownPromise(MobileUpdateInfo);

const bridge =
  typeof window === "undefined"
    ? null
    : ((window as { friendDesktopSelfUpdate?: FriendDesktopSelfUpdateBridge })
        .friendDesktopSelfUpdate ?? null);

/** The bots host publishes the build; set while its connection is up. */
let target: EnvironmentId | null = null;

/** Points the checks at the bots host, or at nothing while it is not connected. */
export function setDesktopSelfUpdateTarget(environmentId: EnvironmentId | null): void {
  target = environmentId;
}

// Same access as the Computer stream: a remote connection carries a short-lived `wsTicket`.
const updateAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: DESKTOP_UPDATE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`desktop-self-update-access:${environmentId}`)),
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

/** The Mac app's self-update, or null outside a fork Mac build. */
export const desktopSelfUpdate =
  bridge === null
    ? null
    : createSelfUpdate({
        embedded: bridge.embedded,
        notConnectedMessage: "O servidor dos bots não está conectado.",
        fetchInfo: async () => {
          if (target === null) return null;
          const response = await fetch(await updateUrl(target, DESKTOP_UPDATE_PATH), {
            headers: { accept: "application/json" },
          });
          if (!response.ok) throw new Error(`o servidor respondeu ${response.status}.`);
          return decodeInfo(await response.json());
        },
        confirmInstall: () =>
          ensureLocalApi().dialogs.confirm(
            "O T3 Code vai fechar e abrir de novo na versão nova. Conversas rodando neste Mac são interrompidas; as do servidor continuam.",
          ),
        downloaded: (build) => bridge.downloaded(build),
        download: async (build, onProgress) => {
          if (target === null) throw new Error("o servidor dos bots não está conectado.");
          const url = await updateUrl(target, DESKTOP_UPDATE_ZIP_PATH, { commit: build.commit });
          return bridge.download(build, url, onProgress);
        },
        inspect: (path) => bridge.inspect(path),
        install: (path, build) => bridge.install(path, build),
        now: Date.now,
      });
