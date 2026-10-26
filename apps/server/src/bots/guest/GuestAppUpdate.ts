/**
 * The guest app's self-update (`GUEST_API_ROUTES.appUpdate`). Each guest's builds live in their own
 * folder, `<T3CODE_GUEST_APP_UPDATE_DIR>/<guest id>` (default `~/.t3-friend/android/<guest id>`),
 * published the same way as the owner's app (AppUpdate: an APK plus an atomically replaced
 * `latest.json`). The folder comes from the authenticated guest, never from the request, so a
 * guest reaches only their own app's APK.
 */
import type { GuestAppUpdateInfo } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";

import { APK_CONTENT_TYPE, configuredDir, readPublished } from "../appUpdate/AppUpdate.ts";
import { GuestApiError } from "./GuestService.ts";
import type { GuestRecord } from "./GuestStore.ts";

export const GUEST_APP_UPDATE_DIR_ENV = "T3CODE_GUEST_APP_UPDATE_DIR";

export interface GuestApk {
  readonly shortCommit: string;
  readonly commit: string;
  readonly size: number;
  readonly bytes: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}

/** The guest app update's two reads, over the directory configured at startup. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const base = yield* configuredDir(GUEST_APP_UPDATE_DIR_ENV);
  const published = (guest: GuestRecord) =>
    readPublished(paths.join(base, guest.id)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, paths),
    );

  const info = Effect.fn("GuestAppUpdate.info")(function* (guest: GuestRecord) {
    const update = yield* published(guest);
    return {
      latest: Option.match(update, { onNone: () => null, onSome: ({ build }) => build }),
    } satisfies GuestAppUpdateInfo;
  });

  /** The published APK; `commit` (when given) must still be the published build. */
  const apk = Effect.fn("GuestAppUpdate.apk")(function* (
    guest: GuestRecord,
    commit: string | null,
  ) {
    const update = yield* published(guest);
    if (Option.isNone(update)) {
      return yield* new GuestApiError({ status: 404, message: "Nenhuma atualização publicada." });
    }
    const { build, path } = update.value;
    if (commit !== null && commit !== build.commit) {
      return yield* new GuestApiError({
        status: 409,
        message: "Saiu uma versão mais nova. Verifique de novo.",
      });
    }
    return {
      commit: build.commit,
      shortCommit: build.shortCommit,
      size: build.size,
      bytes: fs.stream(path),
    } satisfies GuestApk;
  });

  return { info, apk };
});

/** Streams the APK; the app checks its sha256 against the manifest before installing. */
export const apkResponse = (apk: GuestApk) =>
  HttpServerResponse.stream(apk.bytes, {
    contentType: APK_CONTENT_TYPE,
    contentLength: apk.size,
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="app-${apk.shortCommit}.apk"`,
      "x-t3-app-update-commit": apk.commit,
    },
  });
