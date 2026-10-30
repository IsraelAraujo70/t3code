import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { GRANT_COOKIE, routes } from "./VsCodeProxy.ts";
import * as VsCodeServer from "./VsCodeServer.ts";

const OWNER = AuthSessionId.make("owner-session");
const WORKBENCH_PAGE =
  '<html><head><script nonce="n0">mark()</script><meta id="vscode-workbench-web-configuration"></head></html>';

interface Upstreamed {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** The routes over a fake serve-web that records each request, and an auth mock per test. */
const makeHarness = (options: {
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | undefined;
  readonly authenticated?: boolean | undefined;
}) =>
  Effect.gen(function* () {
    const upstreamed: Upstreamed[] = [];
    const revoked = yield* Deferred.make<void>();
    // Completes as the grant's watcher returns; the grant is dropped before this fiber yields.
    const watcherDone = yield* Deferred.make<void>();
    const authRequests: string[] = [];
    const state = { authenticated: options.authenticated ?? true };
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
      authenticateWebSocketUpgrade: (request) => {
        authRequests.push(request.originalUrl);
        if (!state.authenticated) {
          return Effect.fail(
            new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "no session" }),
          );
        }
        return Effect.succeed({
          sessionId: OWNER,
          subject: "owner",
          method: "bearer-access-token",
          scopes: options.scopes ?? [AuthTerminalOperateScope],
        });
      },
    });
    const sessions = Layer.mock(SessionStore.SessionStore, {
      cookieName: "t3_session",
      legacyCookieName: undefined,
      awaitInvalidation: () =>
        Deferred.await(revoked).pipe(Effect.ensuring(Deferred.succeed(watcherDone, undefined))),
    });
    const http = HttpClient.make((request) => {
      upstreamed.push({ url: request.url, headers: { ...request.headers } });
      const headers = new Headers({
        "content-type": "text/html",
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "default-src 'self', frame-ancestors 'self'",
      });
      headers.append("set-cookie", "vscode-secret-key-path=/vscode/mint; Path=/; SameSite=Strict");
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(WORKBENCH_PAGE, { headers })),
      );
    });
    const server = Layer.succeed(VsCodeServer.VsCodeServer, {
      upstream: Effect.succeed({
        http,
        openWebSocket: () => {
          throw new Error("no sockets in this test");
        },
      }),
      holdOpen: Effect.void,
      lost: () => Effect.void,
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routes.pipe(Layer.provide(Layer.mergeAll(server, sessions)), Layer.provideMerge(auth)),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const request = (path: string, headers: Record<string, string> = {}) =>
      Effect.promise(() =>
        handler.handler(new Request(`https://t3.test${path}`, { headers, redirect: "manual" })),
      );
    return { request, upstreamed, authRequests, revoked, watcherDone, state };
  });

const grantFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${GRANT_COOKIE}=`))
    ?.split(";")[0]
    ?.slice(GRANT_COOKIE.length + 1);

it.effect.each([
  { name: "without a session", authenticated: false, scopes: undefined, status: 401 },
  {
    name: "without terminal:operate",
    authenticated: true,
    scopes: [AuthOrchestrationOperateScope],
    status: 403,
  },
])("refuses a request $name before reaching VS Code", (testCase) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(testCase);
    const response = yield* harness.request("/vscode/?folder=/repo&wsTicket=t");
    expect(response.status).toBe(testCase.status);
    expect(harness.upstreamed).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "trades a ticket for a grant cookie, then serves through it without app credentials",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      const traded = yield* harness.request("/vscode/?folder=%2Frepo&wsTicket=one-use");
      expect(traded.status).toBe(303);
      expect(traded.headers.get("location")).toBe("/vscode/?folder=%2Frepo");
      const grant = grantFrom(traded);
      expect(grant).toBeDefined();
      expect(harness.upstreamed).toEqual([]);

      const authCalls = harness.authRequests.length;
      const page = yield* harness.request("/vscode/?folder=%2Frepo", {
        cookie: `${GRANT_COOKIE}=${grant}; t3_session=app-cookie; vscode-secret-half=kept`,
        authorization: "Bearer app-token",
        host: "box.example.ts.net",
        "x-forwarded-proto": "https",
      });
      expect(page.status).toBe(200);
      expect(harness.authRequests.length).toBe(authCalls);
      const [upstream] = harness.upstreamed;
      expect(upstream?.url).toBe(`${VsCodeServer.UPSTREAM_ORIGIN}/vscode/?folder=%2Frepo`);
      expect(upstream?.headers.cookie).toBe("vscode-secret-half=kept");
      expect(upstream?.headers.authorization).toBeUndefined();
      expect(upstream?.headers["x-forwarded-host"]).toBe("box.example.ts.net");

      expect(yield* Effect.promise(() => page.text())).toMatch(
        /^<html><head><script nonce="n0">\(\(\) => \{[\s\S]*t3-color-scheme[\s\S]*<\/script><script nonce="n0">mark\(\)/,
      );
      expect(page.headers.get("x-frame-options")).toBeNull();
      expect(page.headers.get("content-security-policy")).toBe(
        "default-src 'self', frame-ancestors 'self' t3code://app t3code-dev://app",
      );
      expect(page.headers.getSetCookie()).toEqual([
        "vscode-secret-key-path=/vscode/mint; Path=/vscode; Secure; SameSite=None",
      ]);
    }).pipe(Effect.scoped),
);

it.effect("a grant ends with the session it came from", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({});
    const grant = grantFrom(yield* harness.request("/vscode/?wsTicket=one-use"));
    expect(grant).toBeDefined();
    const cookie = { cookie: `${GRANT_COOKIE}=${grant}` };
    harness.state.authenticated = false;
    expect((yield* harness.request("/vscode/", cookie)).status).toBe(200);

    yield* Deferred.succeed(harness.revoked, undefined);
    yield* Deferred.await(harness.watcherDone);
    // The watcher drops the grant in the same run that signalled; let it finish.
    yield* Effect.yieldNow;
    expect((yield* harness.request("/vscode/", cookie)).status).toBe(401);
    expect(harness.upstreamed).toHaveLength(1);
  }).pipe(Effect.scoped),
);
