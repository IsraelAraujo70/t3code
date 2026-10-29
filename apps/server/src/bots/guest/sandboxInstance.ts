/**
 * Which provider instances run a guest's bots inside the Docker sandbox. A sandbox instance is a
 * `claudeAgent` instance whose binary is the fork's launcher (`sandbox/t3-guest-claude`) and whose
 * environment names the guest with `T3CODE_GUEST_ID`. The launcher starts the container; nothing
 * here starts processes.
 *
 * Two checks with opposite failure directions:
 * - `declaresGuest` is broad: any instance naming a guest gets no T3 MCP credential, even when
 *   its binary is misconfigured, so a sandboxed process never holds a token for the host.
 * - `isSandboxedFor` is strict: the guest API sends to a bot only when its instance is enabled,
 *   names that guest, and launches through the real launcher file.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a sync check on the adapter's turn path.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import type { GuestId, ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as ServerSettings from "../../serverSettings.ts";

export const GUEST_ID_ENV = "T3CODE_GUEST_ID";

/** Absolute path of the launcher a sandbox instance's `binaryPath` must point at. */
export const SANDBOX_LAUNCHER_PATH = NodeURL.fileURLToPath(
  new URL("./sandbox/t3-guest-claude", import.meta.url),
);

type ProviderInstances = Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;

const guestEntries = (instance: ProviderInstanceConfig | undefined) =>
  instance?.environment?.filter((variable) => variable.name === GUEST_ID_ENV) ?? [];

/**
 * Pure. The guest id the instance's process receives, or null. The last entry wins, as in
 * mergeProviderInstanceEnvironment.
 */
export function declaredGuest(instance: ProviderInstanceConfig | undefined): string | null {
  const value = guestEntries(instance).at(-1)?.value;
  return value === undefined || value === "" ? null : value;
}

/** Pure. Whether this instance must never receive a T3 MCP credential: any entry names a guest. */
export function declaresGuest(instances: ProviderInstances, instanceId: ProviderInstanceId) {
  return guestEntries(instances[instanceId]).some((variable) => variable.value.trim() !== "");
}

/**
 * For ProviderSessionManager. Unreadable settings withhold the credential: an agent losing its
 * T3 tools for one session is visible and harmless; a sandbox holding a host token is not.
 */
export const withholdsGuestMcp = (
  serverSettings: Option.Option<ServerSettings.ServerSettingsService["Service"]>,
  instanceId: ProviderInstanceId,
): Effect.Effect<boolean> =>
  Option.isNone(serverSettings)
    ? Effect.succeed(false)
    : serverSettings.value.getSettings.pipe(
        Effect.map((settings) => declaresGuest(settings.providerInstances, instanceId)),
        Effect.orElseSucceed(() => true),
      );

/** Pure. The configured binary path when the instance claims to sandbox `guestId`, else null. */
export function sandboxBinaryFor(
  instances: ProviderInstances,
  instanceId: ProviderInstanceId,
  guestId: GuestId,
): string | null {
  const instance = instances[instanceId];
  if (instance === undefined || instance.driver !== "claudeAgent" || instance.enabled === false) {
    return null;
  }
  // Exactly one entry, so the check and the launched process cannot disagree on the guest.
  const entries = guestEntries(instance);
  if (entries.length !== 1 || entries[0]!.value !== guestId) return null;
  const config = instance.config;
  if (typeof config !== "object" || config === null || !("binaryPath" in config)) return null;
  const binaryPath = config.binaryPath;
  return typeof binaryPath === "string" && binaryPath.trim() !== "" ? binaryPath.trim() : null;
}

/** Whether the instance launches `guestId`'s bots through the real launcher file. */
export const isSandboxedFor = Effect.fn("GuestSandbox.isSandboxedFor")(function* (
  instances: ProviderInstances,
  instanceId: ProviderInstanceId,
  guestId: GuestId,
  home: string,
) {
  const binary = sandboxBinaryFor(instances, instanceId, guestId);
  if (binary === null) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolve = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => null));
  const configured = yield* resolve(path.resolve(expandHomePath(binary, home)));
  const launcher = yield* resolve(SANDBOX_LAUNCHER_PATH);
  return configured !== null && configured === launcher;
});

/**
 * Whether a Claude instance's resolved binary is the sandbox launcher. Synchronous for the Claude
 * adapter: a sandboxed turn must not discover the host's skills, which would also let guest text
 * name them as commands.
 */
export function isSandboxLauncher(binaryPath: string | undefined): boolean {
  if (binaryPath === undefined || binaryPath === "") return false;
  try {
    return NodeFS.realpathSync(binaryPath) === NodeFS.realpathSync(SANDBOX_LAUNCHER_PATH);
  } catch {
    return false;
  }
}

/**
 * Whether the instance runs its agent on the host: it names no guest and its binary is not the
 * sandbox launcher. Instances missing from the settings are host defaults.
 */
export function runsOnHost(instances: ProviderInstances, instanceId: ProviderInstanceId): boolean {
  if (declaresGuest(instances, instanceId)) return false;
  const config = instances[instanceId]?.config;
  const binaryPath =
    typeof config === "object" &&
    config !== null &&
    "binaryPath" in config &&
    typeof config.binaryPath === "string"
      ? config.binaryPath.trim()
      : undefined;
  return !isSandboxLauncher(binaryPath);
}
