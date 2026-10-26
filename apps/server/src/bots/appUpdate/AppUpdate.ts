/**
 * Serves the fork's own app updates: the owner's Android APK (`MOBILE_UPDATE_PATH`) and the Mac
 * app's zip (`DESKTOP_UPDATE_PATH`), each from its own directory. The build scripts in
 * `~/.t3-friend` copy a good build into the directory and then replace `latest.json` atomically, so
 * a reader sees the previous build or the new one, never a half-written manifest. The server trusts
 * the manifest's sha256 (hashing a 100+ MB file per check would be wasteful); the app checks it
 * after downloading.
 *
 * These routes live on the main listener only, behind the owner's environment auth. The guest
 * listener has its own router (`GuestApi`) and its own app update.
 */
import * as NodeOS from "node:os";

import {
  AuthOrchestrationReadScope,
  DESKTOP_UPDATE_PATH,
  DESKTOP_UPDATE_ZIP_PATH,
  MOBILE_UPDATE_APK_PATH,
  MOBILE_UPDATE_PATH,
  MobileUpdateBuild,
  type MobileUpdateInfo,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../../auth/http.ts";

export const MOBILE_UPDATE_DIR_ENV = "T3CODE_MOBILE_UPDATE_DIR";
export const DESKTOP_UPDATE_DIR_ENV = "T3CODE_DESKTOP_UPDATE_DIR";
export const MANIFEST_FILE = "latest.json";
export const APK_CONTENT_TYPE = "application/vnd.android.package-archive";

/** The directory named by `env`, or `~/.t3-friend/<fallback>`. Read at startup. */
export const configuredDir = Effect.fn("AppUpdate.configuredDir")(function* (
  env: string,
  fallback = "android",
) {
  const defaultDir = (yield* Path.Path).join(NodeOS.homedir(), ".t3-friend", fallback);
  return yield* Config.String(env).pipe(
    Config.withDefault(defaultDir),
    Effect.orElseSucceed(() => defaultDir),
  );
});

/** What a published file must be: an APK for the Android apps, a zip for the Mac app. */
export type ArtifactKind = "apk" | "zip";

/** `latest.json`: the build plus the file's name inside the update directory. */
const manifestDecoders = {
  apk: Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        ...MobileUpdateBuild.fields,
        file: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+\.apk$/)),
      }),
    ),
  ),
  zip: Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        ...MobileUpdateBuild.fields,
        file: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+\.zip$/)),
      }),
    ),
  ),
} satisfies Record<ArtifactKind, unknown>;

export interface PublishedUpdate {
  readonly build: MobileUpdateBuild;
  readonly path: string;
}

/**
 * The published build, or none when there is no manifest, it does not decode, or its file is
 * missing or not the size it claims. The last two are logged: they mean a broken publish.
 */
export const readPublished = Effect.fn("AppUpdate.readPublished")(function* (
  dir: string,
  kind: ArtifactKind = "apk",
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const raw = yield* fs.readFileString(paths.join(dir, MANIFEST_FILE)).pipe(Effect.option);
  if (Option.isNone(raw)) return Option.none<PublishedUpdate>();
  const manifest = manifestDecoders[kind](raw.value);
  if (Option.isNone(manifest)) {
    yield* Effect.logWarning("The app update manifest is invalid; serving no update.", { dir });
    return Option.none<PublishedUpdate>();
  }
  const { file, ...build } = manifest.value;
  const path = paths.join(dir, file);
  const size = yield* fs.stat(path).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.option,
  );
  if (Option.isNone(size) || size.value !== build.size) {
    yield* Effect.logWarning("The published app update file is missing or the wrong size.", {
      path,
      expected: build.size,
    });
    return Option.none<PublishedUpdate>();
  }
  return Option.some<PublishedUpdate>({ build, path });
});

const NO_STORE = { "cache-control": "no-store" } as const;

interface UpdateRoutes {
  readonly infoPath: HttpRouter.PathInput;
  readonly filePath: HttpRouter.PathInput;
  readonly dirEnv: string;
  readonly defaultDir: string;
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly fileName: (build: MobileUpdateBuild) => string;
  readonly notPublished: string;
}

const MOBILE: UpdateRoutes = {
  infoPath: MOBILE_UPDATE_PATH,
  filePath: MOBILE_UPDATE_APK_PATH,
  dirEnv: MOBILE_UPDATE_DIR_ENV,
  defaultDir: "android",
  kind: "apk",
  contentType: APK_CONTENT_TYPE,
  fileName: (build) => `t3code-friend-${build.shortCommit}.apk`,
  notPublished: "No Android update is published on this server.",
};

const DESKTOP: UpdateRoutes = {
  infoPath: DESKTOP_UPDATE_PATH,
  filePath: DESKTOP_UPDATE_ZIP_PATH,
  dirEnv: DESKTOP_UPDATE_DIR_ENV,
  defaultDir: "desktop",
  kind: "zip",
  contentType: "application/zip",
  fileName: (build) => `t3code-friend-mac-${build.shortCommit}.zip`,
  notPublished: "No Mac update is published on this server.",
};

// The request span already covers these routes.
const serveInfo = Effect.fnUntraced(function* (routes: UpdateRoutes, dir: string) {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const published = yield* readPublished(dir, routes.kind);
  const info: MobileUpdateInfo = {
    latest: Option.match(published, { onNone: () => null, onSome: ({ build }) => build }),
  };
  return yield* HttpServerResponse.json(info, { headers: NO_STORE });
});

const serveFile = Effect.fnUntraced(function* (routes: UpdateRoutes, dir: string) {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const published = yield* readPublished(dir, routes.kind);
  if (Option.isNone(published)) {
    return HttpServerResponse.text(routes.notPublished, { status: 404, headers: NO_STORE });
  }
  const { build, path } = published.value;
  const wanted = Option.flatMap(HttpServerRequest.toURL(request), (url) =>
    Option.fromNullishOr(url.searchParams.get("commit")),
  );
  if (Option.isSome(wanted) && wanted.value !== build.commit) {
    return HttpServerResponse.text("Another build was published since. Check for updates again.", {
      status: 409,
      headers: NO_STORE,
    });
  }
  return yield* HttpServerResponse.file(path, {
    contentType: routes.contentType,
    headers: {
      ...NO_STORE,
      "content-disposition": `attachment; filename="${routes.fileName(build)}"`,
      "x-t3-mobile-update-commit": build.commit,
    },
  });
});

const updateRouteLayer = (routes: UpdateRoutes) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      // Handlers run in the request's context, so they get the layer's file services and the
      // directory from here.
      const platform = yield* Effect.context<
        HttpPlatform.HttpPlatform | FileSystem.FileSystem | Path.Path
      >();
      const dir = yield* configuredDir(routes.dirEnv, routes.defaultDir);
      yield* router.add(
        "GET",
        routes.infoPath,
        serveInfo(routes, dir).pipe(Effect.provideContext(platform)),
      );
      yield* router.add(
        "GET",
        routes.filePath,
        serveFile(routes, dir).pipe(Effect.provideContext(platform)),
      );
    }),
  );

export const routeLayer = Layer.mergeAll(updateRouteLayer(MOBILE), updateRouteLayer(DESKTOP));
