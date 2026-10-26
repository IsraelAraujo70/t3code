import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { GUEST_API_ROUTES, GuestId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpEffect } from "effect/http";

import { MANIFEST_FILE } from "../appUpdate/AppUpdate.ts";
import { GUEST_APP_UPDATE_DIR_ENV } from "./GuestAppUpdate.ts";
import { makeApp } from "./GuestHttp.ts";
import { GuestVoice } from "./GuestVoice.ts";
import { GuestApiError, GuestService } from "./GuestService.ts";
import type { GuestRecord } from "./GuestStore.ts";

const apkBytes = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 251));
const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const commit = "40219dedb6e2f0b3c1d5f4e3a2b1c0d9e8f7a6b5";
const build = {
  commit,
  shortCommit: "40219dedb",
  commitDate: "2026-10-24T09:00:00-03:00",
  builtAt: "2026-10-24T12:30:00Z",
  size: apkBytes.byteLength,
  sha256: await sha256Hex(apkBytes),
};

const guest = (id: string): GuestRecord => ({
  id: GuestId.make(id),
  name: id,
  tokenHash: null,
  tokenCreatedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
const tokens: Record<string, GuestRecord> = {
  "Bearer bia-token": guest("bia"),
  "Bearer ana-token": guest("ana"),
};

const guestServiceLayer = Layer.mock(GuestService, {
  authenticate: (authorization) => {
    const found = authorization === undefined ? undefined : tokens[authorization];
    return found === undefined
      ? Effect.fail(new GuestApiError({ status: 401, message: "Acesso inválido." }))
      : Effect.succeed(found);
  },
});

/** The guest listener's app over `base`, where only Bia publishes, in the state `publish` asks. */
const makeHandler = (publish: "nothing" | "valid" | "short-apk" | "garbage") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-guest-app-update-" });
    const dir = `${base}/bia`;
    yield* fs.makeDirectory(dir);
    if (publish === "garbage") {
      yield* fs.writeFileString(`${dir}/${MANIFEST_FILE}`, "{ not json");
    } else if (publish !== "nothing") {
      const file = `bia-${build.shortCommit}.apk`;
      yield* fs.writeFile(
        `${dir}/${file}`,
        publish === "short-apk" ? apkBytes.subarray(0, 100) : apkBytes,
      );
      yield* fs.writeFileString(`${dir}/${MANIFEST_FILE}`, JSON.stringify({ ...build, file }));
    }
    const app = yield* makeApp.pipe(
      // The listener also serves voice, which these requests never reach.
      Effect.provide(
        Layer.merge(guestServiceLayer, Layer.mock(GuestVoice, {})).pipe(
          Layer.provideMerge(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { [GUEST_APP_UPDATE_DIR_ENV]: base } }),
            ),
          ),
        ),
      ),
    );
    return HttpEffect.toWebHandler(app);
  });

const get = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  token: string | null = "bia-token",
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://guest.test${path}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
    ),
  );

it.layer(NodeServices.layer)("guest app update routes", (it) => {
  it.effect.each(["nothing", "garbage", "short-apk"] as const)(
    "answers latest: null and 404 for the APK when %s is published",
    (publish) =>
      Effect.gen(function* () {
        const handler = yield* makeHandler(publish);
        const info = yield* get(handler, GUEST_API_ROUTES.appUpdate);
        expect(info.status).toBe(200);
        expect(yield* Effect.promise(() => info.json())).toEqual({ latest: null });
        const apk = yield* get(handler, GUEST_API_ROUTES.appUpdateApk);
        expect(apk.status).toBe(404);
        expect(yield* Effect.promise(() => apk.json())).toEqual({
          error: "Nenhuma atualização publicada.",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("describes the guest's published build without its file name", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler("valid");
      const response = yield* get(handler, GUEST_API_ROUTES.appUpdate);
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ latest: build });
    }).pipe(Effect.scoped),
  );

  it.effect("sends the published APK whole, and refuses a stale commit", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler("valid");
      const response = yield* get(handler, `${GUEST_API_ROUTES.appUpdateApk}?commit=${commit}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(response.headers.get("content-length")).toBe(String(build.size));
      const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
      expect(yield* Effect.promise(() => sha256Hex(body))).toBe(build.sha256);

      const stale = yield* get(
        handler,
        `${GUEST_API_ROUTES.appUpdateApk}?commit=${"0".repeat(40)}`,
      );
      expect(stale.status).toBe(409);
    }).pipe(Effect.scoped),
  );

  it.effect("serves another guest only their own folder, and nobody without a token", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler("valid");
      const ana = yield* get(handler, GUEST_API_ROUTES.appUpdate, "ana-token");
      expect(yield* Effect.promise(() => ana.json())).toEqual({ latest: null });
      expect((yield* get(handler, GUEST_API_ROUTES.appUpdateApk, "ana-token")).status).toBe(404);
      for (const token of [null, "wrong"]) {
        expect((yield* get(handler, GUEST_API_ROUTES.appUpdate, token)).status).toBe(401);
        expect((yield* get(handler, GUEST_API_ROUTES.appUpdateApk, token)).status).toBe(401);
      }
    }).pipe(Effect.scoped),
  );
});
