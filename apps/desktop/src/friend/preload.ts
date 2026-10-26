import type { FriendDesktopSelfUpdateBridge } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as Channels from "./selfUpdateChannels.ts";

/** Electron prefixes errors from the main process with "Error invoking remote method …: Error: ". */
const unwrap = async <A>(promise: Promise<A>): Promise<A> => {
  try {
    return await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ""), {
      cause: error,
    });
  }
};

/** Exposes `window.friendDesktopSelfUpdate` when the main process says this build updates itself. */
export function exposeFriendSelfUpdate(): void {
  const embedded: unknown = ipcRenderer.sendSync(Channels.EMBEDDED_CHANNEL);
  if (typeof embedded !== "object" || embedded === null) return;
  contextBridge.exposeInMainWorld("friendDesktopSelfUpdate", {
    embedded: embedded as FriendDesktopSelfUpdateBridge["embedded"],
    downloaded: (build) => unwrap(ipcRenderer.invoke(Channels.DOWNLOADED_CHANNEL, build)),
    download: async (build, url, onProgress) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => {
        if (typeof progress !== "object" || progress === null) return;
        const { commit, fraction } = progress as { commit?: unknown; fraction?: unknown };
        if (commit === build.commit) onProgress(typeof fraction === "number" ? fraction : null);
      };
      ipcRenderer.on(Channels.PROGRESS_CHANNEL, listener);
      try {
        return await unwrap(ipcRenderer.invoke(Channels.DOWNLOAD_CHANNEL, { build, url }));
      } finally {
        ipcRenderer.removeListener(Channels.PROGRESS_CHANNEL, listener);
      }
    },
    inspect: (path) => unwrap(ipcRenderer.invoke(Channels.INSPECT_CHANNEL, path)),
    install: (path, build) => unwrap(ipcRenderer.invoke(Channels.INSTALL_CHANNEL, { path, build })),
  } satisfies FriendDesktopSelfUpdateBridge);
}
