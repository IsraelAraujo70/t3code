import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  MOBILE_UPDATE_APK_PATH,
  MOBILE_UPDATE_PATH,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { MANIFEST_FILE, MOBILE_UPDATE_DIR_ENV, routeLayer } from "./MobileUpdate.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));
const apkBytes = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 251));
const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const apkSha256 = await sha256Hex(apkBytes);
const commit = "cc5abf0b0c6e2f0b3c1d5f4e3a2b1c0d9e8f7a6b";
const build = {
  commit,
  shortCommit: "cc5abf0b0c",
  commitDate: "2026-10-24T09:00:00-03:00",
  builtAt: "2026-10-24T12:30:00Z",
  size: apkBytes.byteLength,
  sha256: apkSha256,
};

/** A request handler over the update routes, reading `dir`, as a session holding `scopes`. */
const makeHandler = (
  dir: string,
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationReadScope],
  error?: EnvironmentAuth.ServerAuthCredentialError,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        routeLayer.pipe(
          Layer.provide(platformLayer),
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [MOBILE_UPDATE_DIR_ENV]: dir } })),
          ),
          Layer.provideMerge(
            Layer.mock(EnvironmentAuth.EnvironmentAuth, {
              authenticateWebSocketUpgrade: () =>
                error
                  ? Effect.fail(error)
                  : Effect.succeed({
                      sessionId: AuthSessionId.make("mobile-update-test"),
                      subject: "mobile-update-test",
                      method: "bearer-access-token",
                      scopes,
                    }),
            }),
          ),
        ),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  );

const get = (
  handler: { readonly handler: (request: Request) => Promise<Response> },
  path: string,
) => Effect.promise(() => handler.handler(new Request(`http://t3.test${path}`)));

/** A temporary update directory, optionally holding a published build. */
const makeDir = (publish: "nothing" | "valid" | "short-apk" | "garbage") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mobile-update-" });
    if (publish === "nothing") return dir;
    if (publish === "garbage") {
      yield* fs.writeFileString(`${dir}/${MANIFEST_FILE}`, "{ not json");
      return dir;
    }
    const file = `t3code-friend-preview-${build.shortCommit}.apk`;
    yield* fs.writeFile(
      `${dir}/${file}`,
      publish === "short-apk" ? apkBytes.subarray(0, 100) : apkBytes,
    );
    yield* fs.writeFileString(`${dir}/${MANIFEST_FILE}`, JSON.stringify({ ...build, file }));
    return dir;
  });

it.layer(NodeServices.layer)("mobile update routes", (it) => {
  it.effect.each(["nothing", "garbage", "short-apk"] as const)(
    "answers latest: null and a clear 404 when %s is published",
    (publish) =>
      Effect.gen(function* () {
        const handler = yield* makeHandler(yield* makeDir(publish));
        const info = yield* get(handler, MOBILE_UPDATE_PATH);
        expect(info.status).toBe(200);
        expect(yield* Effect.promise(() => info.json())).toEqual({ latest: null });
        const apk = yield* get(handler, MOBILE_UPDATE_APK_PATH);
        expect(apk.status).toBe(404);
        expect(yield* Effect.promise(() => apk.text())).toBe(
          "No Android update is published on this server.",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("describes the published build without its file name", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler(yield* makeDir("valid"));
      const response = yield* get(handler, MOBILE_UPDATE_PATH);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => response.json())).toEqual({ latest: build });
    }).pipe(Effect.scoped),
  );

  it.effect("sends the published APK whole, and refuses a stale commit", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler(yield* makeDir("valid"));
      const response = yield* get(handler, `${MOBILE_UPDATE_APK_PATH}?commit=${commit}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
      expect(body.byteLength).toBe(build.size);
      expect(yield* Effect.promise(() => sha256Hex(body))).toBe(build.sha256);

      const stale = yield* get(handler, `${MOBILE_UPDATE_APK_PATH}?commit=${"0".repeat(40)}`);
      expect(stale.status).toBe(409);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "no credential",
      scopes: [],
      error: new EnvironmentAuth.ServerAuthMissingCredentialError({}),
      status: 401,
    },
    { name: "no orchestration:read", scopes: [], error: undefined, status: 403 },
  ])("refuses a session with $name", (testCase) =>
    Effect.gen(function* () {
      const handler = yield* makeHandler(yield* makeDir("valid"), testCase.scopes, testCase.error);
      expect((yield* get(handler, MOBILE_UPDATE_PATH)).status).toBe(testCase.status);
      expect((yield* get(handler, MOBILE_UPDATE_APK_PATH)).status).toBe(testCase.status);
    }).pipe(Effect.scoped),
  );
});
