import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  DESKTOP_UPDATE_PATH,
  DESKTOP_UPDATE_ZIP_PATH,
  MOBILE_UPDATE_APK_PATH,
  MOBILE_UPDATE_PATH,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  DESKTOP_UPDATE_DIR_ENV,
  MANIFEST_FILE,
  MOBILE_UPDATE_DIR_ENV,
  routeLayer,
} from "./AppUpdate.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));
const fileBytes = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 251));
const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const fileSha256 = await sha256Hex(fileBytes);
const commit = "cc5abf0b0c6e2f0b3c1d5f4e3a2b1c0d9e8f7a6b";
const build = {
  commit,
  shortCommit: "cc5abf0b0c",
  commitDate: "2026-10-24T09:00:00-03:00",
  builtAt: "2026-10-24T12:30:00Z",
  size: fileBytes.byteLength,
  sha256: fileSha256,
};

/** The Android and Mac routes: where each reads, what it serves, and what it must refuse. */
const apps = [
  {
    name: "Android",
    env: MOBILE_UPDATE_DIR_ENV,
    infoPath: MOBILE_UPDATE_PATH,
    filePath: MOBILE_UPDATE_APK_PATH,
    extension: "apk",
    otherExtension: "zip",
    contentType: "application/vnd.android.package-archive",
    notPublished: "No Android update is published on this server.",
  },
  {
    name: "Mac",
    env: DESKTOP_UPDATE_DIR_ENV,
    infoPath: DESKTOP_UPDATE_PATH,
    filePath: DESKTOP_UPDATE_ZIP_PATH,
    extension: "zip",
    otherExtension: "apk",
    contentType: "application/zip",
    notPublished: "No Mac update is published on this server.",
  },
] as const;
type App = (typeof apps)[number];

/** A request handler over the update routes, reading `dir` for `app`, as a session holding `scopes`. */
const makeHandler = (
  app: App,
  dir: string,
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationReadScope],
  error?: EnvironmentAuth.ServerAuthCredentialError,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        routeLayer.pipe(
          Layer.provide(platformLayer),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [app.env]: dir } }))),
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

/**
 * A temporary update directory, optionally holding a published build of `extension` (the other
 * app's kind of file, published here by mistake, must not be served).
 */
const makeDir = (
  publish: "nothing" | "valid" | "short-file" | "garbage",
  extension: "apk" | "zip" = "apk",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-app-update-" });
    if (publish === "nothing") return dir;
    if (publish === "garbage") {
      yield* fs.writeFileString(`${dir}/${MANIFEST_FILE}`, "{ not json");
      return dir;
    }
    const file = `t3code-friend-${build.shortCommit}.${extension}`;
    yield* fs.writeFile(
      `${dir}/${file}`,
      publish === "short-file" ? fileBytes.subarray(0, 100) : fileBytes,
    );
    yield* fs.writeFileString(`${dir}/${MANIFEST_FILE}`, JSON.stringify({ ...build, file }));
    return dir;
  });

const publishCases = [
  ...(["nothing", "garbage", "short-file"] as const).flatMap((publish) =>
    apps.map((app) => ({ app, publish, extension: app.extension, label: publish })),
  ),
  ...apps.map((app) => ({
    app,
    publish: "valid" as const,
    extension: app.otherExtension,
    label: `a .${app.otherExtension}`,
  })),
];

it.layer(NodeServices.layer)("app update routes", (it) => {
  it.effect.each(publishCases)(
    "$app.name: answers latest: null and a clear 404 when $label is published",
    ({ app, publish, extension }) =>
      Effect.gen(function* () {
        const handler = yield* makeHandler(app, yield* makeDir(publish, extension));
        const info = yield* get(handler, app.infoPath);
        expect(info.status).toBe(200);
        expect(yield* Effect.promise(() => info.json())).toEqual({ latest: null });
        const file = yield* get(handler, app.filePath);
        expect(file.status).toBe(404);
        expect(yield* Effect.promise(() => file.text())).toBe(app.notPublished);
      }).pipe(Effect.scoped),
  );

  it.effect.each(apps)("$name: describes the published build without its file name", (app) =>
    Effect.gen(function* () {
      const handler = yield* makeHandler(app, yield* makeDir("valid", app.extension));
      const response = yield* get(handler, app.infoPath);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => response.json())).toEqual({ latest: build });
    }).pipe(Effect.scoped),
  );

  it.effect.each(apps)("$name: sends the published file whole, and refuses a stale commit", (app) =>
    Effect.gen(function* () {
      const handler = yield* makeHandler(app, yield* makeDir("valid", app.extension));
      const response = yield* get(handler, `${app.filePath}?commit=${commit}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(app.contentType);
      const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
      expect(body.byteLength).toBe(build.size);
      expect(yield* Effect.promise(() => sha256Hex(body))).toBe(build.sha256);

      const stale = yield* get(handler, `${app.filePath}?commit=${"0".repeat(40)}`);
      expect(stale.status).toBe(409);
    }).pipe(Effect.scoped),
  );

  // A guest's token is not an environment session, so the main listener sees no credential; the
  // guest listener's own router has no route here at all.
  it.effect.each(
    apps.flatMap((app) => [
      {
        app,
        name: "no credential (a guest's token)",
        scopes: [],
        error: new EnvironmentAuth.ServerAuthMissingCredentialError({}),
        status: 401,
      },
      { app, name: "no orchestration:read", scopes: [], error: undefined, status: 403 },
    ]),
  )("$app.name: refuses a session with $name", (testCase) =>
    Effect.gen(function* () {
      const handler = yield* makeHandler(
        testCase.app,
        yield* makeDir("valid", testCase.app.extension),
        testCase.scopes,
        testCase.error,
      );
      expect((yield* get(handler, testCase.app.infoPath)).status).toBe(testCase.status);
      expect((yield* get(handler, testCase.app.filePath)).status).toBe(testCase.status);
    }).pipe(Effect.scoped),
  );
});
