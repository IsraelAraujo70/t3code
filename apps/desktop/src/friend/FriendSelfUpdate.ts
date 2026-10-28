/**
 * The main-process half of the fork's Mac self-update: IPC methods over `macAppInstaller.ts`, and
 * the relaunch once the new bundle is in place. It turns on only in a packaged Mac build that
 * carries `friendBuild` (written by `scripts/build-desktop-artifact.ts`) and no `app-update.yml`, so
 * it never runs next to upstream's electron-updater.
 */
import { readEmbeddedBuild } from "@t3tools/client-runtime/app-self-update";
import { MobileUpdateBuild } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as Installer from "./macAppInstaller.ts";
import * as Channels from "./selfUpdateChannels.ts";

export class FriendSelfUpdateError extends Schema.TaggedError<FriendSelfUpdateError>()(
  "FriendSelfUpdateError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const EmbeddedBuild = Schema.NullOr(
  Schema.Struct({ commit: Schema.String, commitDate: Schema.String }),
);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const run = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new FriendSelfUpdateError({
        reason:
          cause instanceof Error && cause.message ? cause.message : `erro inesperado: ${cause}`,
      }),
  });

/** The running build, when this app updates itself from the bots host. */
const resolveEmbedded = Effect.fn("friend.selfUpdate.resolveEmbedded")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  if (environment.platform !== "darwin" || !environment.isPackaged) return null;
  if (yield* fs.exists(environment.appUpdateYmlPath).pipe(Effect.orElseSucceed(() => true))) {
    return null;
  }
  const currentApp = Installer.bundlePathOf(process.execPath);
  // A translocated app runs from a read-only mount; there is nothing to replace.
  if (currentApp === null || currentApp.includes("/AppTranslocation/")) return null;
  const raw = yield* fs
    .readFileString(environment.path.join(environment.appRoot, "package.json"))
    .pipe(Effect.option);
  if (Option.isNone(raw)) return null;
  const parsed = yield* decodeJson(raw.value).pipe(Effect.option);
  return Option.isSome(parsed) ? readEmbeddedBuild(parsed.value) : null;
});

/** Registers the self-update IPC. Without an embedded build only `embedded` (null) answers. */
export const installFriendSelfUpdate = Effect.fn("friend.selfUpdate.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const embedded = yield* resolveEmbedded();
  yield* ipc.handleSync(
    DesktopIpc.makeSyncIpcMethod({
      channel: Channels.EMBEDDED_CHANNEL,
      result: EmbeddedBuild,
      handler: () => Effect.succeed(embedded),
    }),
  );
  const currentApp = Installer.bundlePathOf(process.execPath);
  if (embedded === null || currentApp === null) return;

  const home = environment.homeDirectory;
  const dir = environment.path.join(home, "Library", "Caches", "t3code-friend-update");
  const insideDir = (path: string) =>
    environment.path.dirname(path) === dir
      ? Effect.succeed(path)
      : Effect.fail(new FriendSelfUpdateError({ reason: "arquivo fora da pasta de atualização." }));

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.DOWNLOADED_CHANNEL,
      payload: MobileUpdateBuild,
      result: Schema.NullOr(Schema.String),
      handler: Effect.fn("friend.selfUpdate.downloaded")(function* (build) {
        const fs = yield* FileSystem.FileSystem;
        const path = Installer.zipPathFor(dir, build);
        return (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) ? path : null;
      }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.DOWNLOAD_CHANNEL,
      payload: Schema.Struct({ build: MobileUpdateBuild, url: Schema.String }),
      result: Schema.String,
      handler: Effect.fn("friend.selfUpdate.download")(function* ({ build, url }) {
        const window = yield* ElectronWindow.ElectronWindow;
        const runFork = Effect.runForkWith(yield* Effect.context<never>());
        const checked = yield* Effect.try({
          try: () => Installer.checkDownloadUrl(url, build),
          catch: (cause) => new FriendSelfUpdateError({ reason: String((cause as Error).message) }),
        });
        return yield* run(() =>
          Installer.download({
            dir,
            url: checked,
            build,
            onProgress: (fraction) => {
              runFork(
                window.sendAll(Channels.PROGRESS_CHANNEL, { commit: build.commit, fraction }),
              );
            },
          }),
        );
      }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.INSPECT_CHANNEL,
      payload: Schema.String,
      result: Schema.Struct({ sha256: Schema.String, size: Schema.Number }),
      handler: Effect.fn("friend.selfUpdate.inspect")(function* (path) {
        const file = yield* insideDir(path);
        return yield* run(() => Installer.inspectFile(file));
      }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.INSTALL_CHANNEL,
      payload: Schema.Struct({ path: Schema.String, build: MobileUpdateBuild }),
      result: Schema.Void,
      handler: Effect.fn("friend.selfUpdate.installUpdate")(function* ({ path, build }) {
        const zip = yield* insideDir(path);
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const stamp = Installer.backupStamp(DateTime.toDate(yield* DateTime.now));
        const { backup } = yield* run(() =>
          Installer.install({
            zip,
            build,
            currentApp,
            workDir: dir,
            home,
            stamp,
            tools: Installer.macTools,
          }),
        );
        yield* Effect.logInfo("friend self-update installed; relaunching", {
          commit: build.commit,
          backup,
        });
        yield* lifecycle.relaunch("friend-self-update");
      }),
    }),
  );
});
