/**
 * Serves the friend Android app's own updates (see `MOBILE_UPDATE_PATH` in the bots contract).
 * `~/.t3-friend/build-mobile-apk.sh` copies each good build into the update directory and then
 * replaces `latest.json` atomically, so a reader sees the previous build or the new one, never a
 * half-written manifest. The server trusts the manifest's sha256 (hashing a 100 MB APK per check
 * would be wasteful); the app checks it after downloading.
 */
import * as NodeOS from "node:os";

import {
  AuthOrchestrationReadScope,
  MOBILE_UPDATE_APK_PATH,
  MOBILE_UPDATE_PATH,
  MobileUpdateBuild,
  type MobileUpdateInfo,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../../auth/http.ts";

export const MOBILE_UPDATE_DIR_ENV = "T3CODE_MOBILE_UPDATE_DIR";
export const MANIFEST_FILE = "latest.json";
export const APK_CONTENT_TYPE = "application/vnd.android.package-archive";

/** The directory named by `env`, or `~/.t3-friend/android`. Read at startup. */
export const configuredDir = Effect.fn("MobileUpdate.configuredDir")(function* (env: string) {
  const fallback = (yield* Path.Path).join(NodeOS.homedir(), ".t3-friend", "android");
  return yield* Config.String(env).pipe(
    Config.withDefault(fallback),
    Effect.orElseSucceed(() => fallback),
  );
});

/** The update directory: `T3CODE_MOBILE_UPDATE_DIR`, or `~/.t3-friend/android`. */
export const updateDir = configuredDir(MOBILE_UPDATE_DIR_ENV);

/** `latest.json`: the build plus the APK's file name inside the update directory. */
const PublishedManifest = Schema.Struct({
  ...MobileUpdateBuild.fields,
  file: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+\.apk$/)),
});
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(PublishedManifest));

export interface PublishedUpdate {
  readonly build: MobileUpdateBuild;
  readonly path: string;
}

/**
 * The published build, or none when there is no manifest, it does not decode, or its APK is
 * missing or not the size it claims. The last two are logged: they mean a broken publish.
 */
export const readPublished = Effect.fn("MobileUpdate.readPublished")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const raw = yield* fs.readFileString(paths.join(dir, MANIFEST_FILE)).pipe(Effect.option);
  if (Option.isNone(raw)) return Option.none<PublishedUpdate>();
  const manifest = decodeManifest(raw.value);
  if (Option.isNone(manifest)) {
    yield* Effect.logWarning("The mobile update manifest is invalid; serving no update.", { dir });
    return Option.none<PublishedUpdate>();
  }
  const { file, ...build } = manifest.value;
  const path = paths.join(dir, file);
  const size = yield* fs.stat(path).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.option,
  );
  if (Option.isNone(size) || size.value !== build.size) {
    yield* Effect.logWarning("The published mobile update APK is missing or the wrong size.", {
      path,
      expected: build.size,
    });
    return Option.none<PublishedUpdate>();
  }
  return Option.some<PublishedUpdate>({ build, path });
});

const NO_STORE = { "cache-control": "no-store" } as const;

// The request span already covers these routes.
const serveInfo = Effect.fnUntraced(function* (dir: string) {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const published = yield* readPublished(dir);
  const info: MobileUpdateInfo = {
    latest: Option.match(published, { onNone: () => null, onSome: ({ build }) => build }),
  };
  return yield* HttpServerResponse.json(info, { headers: NO_STORE });
});

const serveApk = Effect.fnUntraced(function* (dir: string) {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const published = yield* readPublished(dir);
  if (Option.isNone(published)) {
    return HttpServerResponse.text("No Android update is published on this server.", {
      status: 404,
      headers: NO_STORE,
    });
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
    contentType: APK_CONTENT_TYPE,
    headers: {
      ...NO_STORE,
      "content-disposition": `attachment; filename="t3code-friend-${build.shortCommit}.apk"`,
      "x-t3-mobile-update-commit": build.commit,
    },
  });
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // Handlers run in the request's context, so they get the layer's file services and the
    // directory from here.
    const platform = yield* Effect.context<
      HttpPlatform.HttpPlatform | FileSystem.FileSystem | Path.Path
    >();
    const dir = yield* updateDir;
    yield* router.add(
      "GET",
      MOBILE_UPDATE_PATH,
      serveInfo(dir).pipe(Effect.provideContext(platform)),
    );
    yield* router.add(
      "GET",
      MOBILE_UPDATE_APK_PATH,
      serveApk(dir).pipe(Effect.provideContext(platform)),
    );
  }),
);
