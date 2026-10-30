// @effect-diagnostics nodeBuiltinImport:off - grant tokens need only randomBytes, called once per opened tab.
/**
 * VS Code's HTTP and WebSocket traffic for sessions holding terminal:operate. An iframe cannot send
 * a bearer token, so a media `wsTicket` is traded once for a grant cookie scoped to this path that
 * dies with its session. The guest listener has no such route. See FORK.md, "VS Code".
 */
import * as NodeCrypto from "node:crypto";

import { AuthTerminalOperateScope, type AuthSessionId, VSCODE_BASE_PATH } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  Cookies,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../../auth/http.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { withColorSchemeShim } from "./colorScheme.ts";
import * as VsCodeServer from "./VsCodeServer.ts";

/** Two names for one grant: SameSite=None reaches a cross-site frame but needs a secure origin. */
export const GRANT_COOKIE = "t3_vscode";
export const GRANT_COOKIE_LAX = "t3_vscode_lax";
const STRIPPED_QUERY_PARAMS = ["wsTicket", "dpop"];
/** The app's own windows: the desktop renderer's schemes; web serves VS Code from its own origin. */
const FRAME_ANCESTORS = "'self' t3code://app t3code-dev://app";
/** Extra origins allowed to embed VS Code, space separated, for a web client on another origin. */
export const VSCODE_FRAME_ANCESTORS_ENV = "T3CODE_VSCODE_FRAME_ANCESTORS";
const MAX_GRANTS = 64;

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-original-host",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "x-frame-options",
  "content-security-policy",
]);

/** Grants live in memory: after a server restart the tab asks for a new ticket. */
export interface VsCodeGrants {
  readonly lookup: (token: string) => AuthSessionId | undefined;
  /** A new grant that lasts as long as the session. */
  readonly issue: (sessionId: AuthSessionId) => Effect.Effect<string>;
}

export const makeGrants = Effect.fn("VsCodeProxy.makeGrants")(function* (
  sessions: SessionStore.SessionStore["Service"],
) {
  const scope = yield* Effect.scope;
  const grants = new Map<string, AuthSessionId>();
  return {
    lookup: (token) => grants.get(token),
    issue: Effect.fn("VsCodeGrants.issue")(function* (sessionId: AuthSessionId) {
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      if (grants.size >= MAX_GRANTS) {
        const oldest = grants.keys().next().value;
        if (oldest !== undefined) grants.delete(oldest);
      }
      grants.set(token, sessionId);
      yield* sessions
        .awaitInvalidation(sessionId)
        .pipe(
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => grants.delete(token))),
          Effect.forkIn(scope),
        );
      return token;
    }),
  } satisfies VsCodeGrants;
});

const isLoopbackHost = (host: string) =>
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host);

/** Whether the browser sees this origin as secure, so it keeps `Secure` cookies. */
export const isSecureOrigin = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["x-forwarded-proto"]?.split(",")[0]?.trim() === "https" ||
  isLoopbackHost(request.headers.host ?? "");

/** Headers for serve-web: the browser's own minus the app's credentials. */
export const upstreamRequestHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  // VS Code builds its remote authority from the host the browser used.
  if (request.headers.host !== undefined) headers["x-forwarded-host"] = request.headers.host;
  const vscodeCookies = Object.entries(request.cookies)
    .filter(([name]) => name.startsWith("vscode-"))
    .map(([name, value]) => `${name}=${value}`);
  if (vscodeCookies.length > 0) headers.cookie = vscodeCookies.join("; ");
  return headers;
};

/** Every policy serve-web sent minus its frame-ancestors, then ours. */
export const browserContentSecurityPolicy = (
  upstreamPolicy: string | undefined,
  extraAncestors = "",
) =>
  [
    ...(upstreamPolicy ?? "")
      .split(",")
      .map((policy) =>
        policy
          .split(";")
          .map((directive) => directive.trim())
          .filter(
            (directive) =>
              directive !== "" && !directive.toLowerCase().startsWith("frame-ancestors"),
          )
          .join("; "),
      )
      .filter((policy) => policy !== ""),
    `frame-ancestors ${FRAME_ANCESTORS} ${extraAncestors}`.trim(),
  ].join(", ");

/**
 * serve-web's cookies for the browser: scoped to this path and usable in a frame.
 * Values pass through as sent: VS Code reads some of them raw from `document.cookie`.
 */
export const browserCookies = (upstream: Cookies.Cookies, secure: boolean) =>
  Cookies.fromSetCookie(
    Object.values(upstream.cookies).map((cookie) =>
      [
        `${cookie.name}=${cookie.valueEncoded}`,
        `Path=${VSCODE_BASE_PATH}`,
        ...(cookie.options?.maxAge === undefined
          ? []
          : [`Max-Age=${Math.floor(Duration.toSeconds(cookie.options.maxAge))}`]),
        ...(cookie.options?.httpOnly ? ["HttpOnly"] : []),
        ...(secure ? ["SameSite=None", "Secure"] : ["SameSite=Lax"]),
      ].join("; "),
    ),
  );

const grantCookies = (token: string) =>
  Cookies.fromIterable([
    Cookies.makeCookieUnsafe(GRANT_COOKIE, token, {
      path: VSCODE_BASE_PATH,
      httpOnly: true,
      sameSite: "none",
      secure: true,
    }),
    Cookies.makeCookieUnsafe(GRANT_COOKIE_LAX, token, {
      path: VSCODE_BASE_PATH,
      httpOnly: true,
      sameSite: "lax",
    }),
  ]);

const textResponse = (status: number, message: string) =>
  HttpServerResponse.text(message, { status, headers: { "cache-control": "no-store" } });

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const errorPage = (message: string) =>
  HttpServerResponse.html(
    `<!doctype html><meta charset="utf-8"><title>VS Code</title><body style="font:14px system-ui;padding:24px;color:#888">${escapeHtml(message)}</body>`,
  ).pipe(
    HttpServerResponse.setStatus(503),
    HttpServerResponse.setHeader("cache-control", "no-store"),
  );

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const pumpFrames =
  /* Frame pumping runs for the socket's life; a span per stream adds nothing. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

interface ProxyServices {
  readonly server: VsCodeServer.VsCodeServer["Service"];
  readonly sessions: SessionStore.SessionStore["Service"];
  readonly grants: VsCodeGrants;
  readonly frameAncestors: string;
}

const proxyWebSocket = Effect.fn("VsCodeProxy.proxyWebSocket")(function* (
  { server, sessions }: ProxyServices,
  request: HttpServerRequest.HttpServerRequest,
  upstream: VsCodeServer.VsCodeUpstream,
  upstreamUrl: string,
  sessionId: AuthSessionId,
) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* server.holdOpen;
      const client = yield* request.upgrade;
      const socket = yield* Socket.makeWebSocket(upstreamUrl, {
        openTimeout: "10 seconds",
      }).pipe(Effect.provideService(Socket.WebSocketConstructor, upstream.openWebSocket));
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* socket.writer;
      yield* Effect.raceFirst(
        Effect.raceFirst(pumpFrames(socket, writeToClient), pumpFrames(client, writeToUpstream)),
        sessions.awaitInvalidation(sessionId),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("VsCodeProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstream: VsCodeServer.VsCodeUpstream,
  upstreamUrl: string,
  frameAncestors: string,
) {
  const httpClient = HttpClient.withScope(upstream.http);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(upstreamRequestHeaders(request)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  headers["content-security-policy"] = browserContentSecurityPolicy(
    response.headers["content-security-policy"],
    frameAncestors,
  );
  const contentType = headers["content-type"];
  const options = { status: response.status, headers, ...(contentType ? { contentType } : {}) };
  // Only HTML is read whole: the workbench page gets the color-scheme shim.
  const proxiedResponse = contentType?.startsWith("text/html")
    ? HttpServerResponse.text(withColorSchemeShim(yield* response.text), options)
    : HttpServerResponse.stream(response.stream, options);
  return proxiedResponse.pipe((proxied) =>
    HttpServerResponse.mergeCookies(
      proxied,
      browserCookies(response.cookies, isSecureOrigin(request)),
    ),
  );
});

/** Who is asking: a grant cookie, or the app's own session check. */
const authorize = Effect.fn("VsCodeProxy.authorize")(function* (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  grants: VsCodeGrants,
) {
  for (const name of [GRANT_COOKIE, GRANT_COOKIE_LAX]) {
    const token = request.cookies[name];
    const sessionId = token === undefined ? undefined : grants.lookup(token);
    if (sessionId !== undefined) return { sessionId, grant: undefined };
  }
  const session = yield* authenticateMediaRequest(AuthTerminalOperateScope);
  if (!url.searchParams.has("wsTicket") || isWebSocketUpgrade(request)) {
    return { sessionId: session.sessionId, grant: undefined };
  }
  return { sessionId: session.sessionId, grant: yield* grants.issue(session.sessionId) };
});

const withoutCredentials = (url: URL) => {
  const search = new URLSearchParams(url.search);
  for (const name of STRIPPED_QUERY_PARAMS) search.delete(name);
  return search;
};

const deny = (status: number, message: string) =>
  Effect.succeed({ ok: false as const, response: textResponse(status, message) });

const makeHandler = Effect.fn("VsCodeProxy.handle")(function* (services: ProxyServices) {
  const { grants, server } = services;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return textResponse(400, "Bad Request");
  const access = yield* authorize(request, url.value, grants).pipe(
    Effect.map((value) => ({ ok: true as const, ...value })),
    Effect.catchTags({
      EnvironmentAuthInvalidError: () => deny(401, "Unauthorized"),
      EnvironmentScopeRequiredError: () => deny(403, "Forbidden"),
      EnvironmentInternalError: () => deny(500, "Internal Error"),
    }),
  );
  if (!access.ok) return access.response;
  const search = withoutCredentials(url.value);
  const query = search.size > 0 ? `?${search.toString()}` : "";
  if (access.grant !== undefined) {
    // The ticket stays out of VS Code's address bar, history and requests.
    return HttpServerResponse.redirect(`${url.value.pathname}${query}`, {
      status: 303,
      headers: { "cache-control": "no-store" },
    }).pipe((response) => HttpServerResponse.mergeCookies(response, grantCookies(access.grant)));
  }
  const upstream = yield* Effect.result(server.upstream);
  if (upstream._tag === "Failure") return errorPage(upstream.failure.message);
  const path = `${url.value.pathname}${query}`;
  if (isWebSocketUpgrade(request)) {
    return yield* proxyWebSocket(
      services,
      request,
      upstream.success,
      `${VsCodeServer.UPSTREAM_ORIGIN.replace(/^http/, "ws")}${path}`,
      access.sessionId,
    );
  }
  return yield* proxyHttp(
    request,
    upstream.success,
    `${VsCodeServer.UPSTREAM_ORIGIN}${path}`,
    services.frameAncestors,
  ).pipe(
    Effect.catchTags({
      HttpClientError: () =>
        Effect.as(
          server.lost(upstream.success),
          errorPage("VS Code stopped answering. Reload the tab to start it again."),
        ),
    }),
  );
});

/** The routes without the serve-web process, so tests can supply a fake one. */
export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const handler = makeHandler({
      server: yield* VsCodeServer.VsCodeServer,
      sessions,
      grants: yield* makeGrants(sessions),
      frameAncestors: yield* Config.String(VSCODE_FRAME_ANCESTORS_ENV).pipe(Config.withDefault("")),
    });
    yield* router.add("*", `${VSCODE_BASE_PATH}/*`, handler);
  }),
);

export const routeLayer = routes.pipe(Layer.provide(VsCodeServer.layer));
