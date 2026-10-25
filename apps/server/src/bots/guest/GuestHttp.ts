/**
 * The guest listener: its own HTTP server and router, separate from the main T3 listener, bound
 * to `T3CODE_GUEST_LISTEN` (`host:port`; production binds the tailnet address). Unset, there is
 * no guest listener.
 *
 * The router holds only GUEST_API_ROUTES, so every other path, the T3 RPC WebSocket included,
 * answers 404 here by construction. Each handler authenticates the bearer token before reading
 * anything else, decodes its input strictly, and calls one GuestService or GuestVoice method.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the listener's own Node server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  GUEST_API_ROUTES,
  GUEST_LIMITS,
  GuestPushDeviceInput,
  GuestPushDeviceRef,
  GuestSendInput,
  GuestVoiceInput,
  VoiceReportInput,
  VoiceSessionRef,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ByteSize from "effect/ByteSize";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as GuestAppUpdate from "./GuestAppUpdate.ts";
import { GuestApiError, GuestService } from "./GuestService.ts";
import { GuestVoice } from "./GuestVoice.ts";

export const GUEST_LISTEN_ENV = "T3CODE_GUEST_LISTEN";

const KEEP_ALIVE = "25 seconds";

/**
 * T3's own policy for agent HTML (http.ts): the sandbox gives the page an opaque origin, so its
 * scripts run but never reach this API with the guest's token, cookies or storage, and it raises
 * no modal dialogs.
 */
export const GUEST_HTML_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-downloads";
const encoder = new TextEncoder();

/** Pure. `127.0.0.1:3794`, `[::1]:3794`; null for anything else. */
export function parseGuestListen(value: string): { host: string; port: number } | null {
  const match = /^(?:\[([0-9a-fA-F:]+)\]|([0-9A-Za-z.-]+)):(\d{1,5})$/.exec(value.trim());
  if (match === null) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return null;
  return { host: (match[1] ?? match[2])!, port };
}

const errorResponse = (error: GuestApiError) =>
  HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status });

const badRequest = (message: string) => new GuestApiError({ status: 400, message });
const notFound = () => new GuestApiError({ status: 404, message: "Não encontrado." });

/** Photos travel as data URLs: the send limit fits GUEST_LIMITS' images plus the text. */
const SEND_BODY_LIMIT = ByteSize.mebibytes(46);
const SMALL_BODY_LIMIT = ByteSize.kibibytes(16);

const tooLarge = () => new GuestApiError({ status: 413, message: "Pedido grande demais." });

/**
 * Reads at most `limit` bytes (chunked bodies included, the stream is cut once it passes) and
 * decodes strictly: unknown keys (a model, an effort, anything) fail instead of being ignored.
 */
const decodeBody = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  limit: ByteSize.ByteSize,
) =>
  Effect.fn("GuestHttp.decodeBody")(function* (request: HttpServerRequest.HttpServerRequest) {
    const declared = Number(request.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > Number(limit)) return yield* tooLarge();
    const body = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, limit),
      Effect.mapError((cause) =>
        String(cause).includes("maxBytes") ? tooLarge() : badRequest("Pedido inválido."),
      ),
    );
    return yield* Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" }).pipe(
      Effect.mapError((issue) => badRequest(`Pedido inválido: ${issue.message}`)),
    );
  });

const decodeSend = decodeBody(GuestSendInput, SEND_BODY_LIMIT);
const decodePushRegister = decodeBody(GuestPushDeviceInput, SMALL_BODY_LIMIT);
const decodePushRef = decodeBody(GuestPushDeviceRef, SMALL_BODY_LIMIT);
// An SDP offer is a few KB; the contract caps it at 64 KiB.
const decodeVoice = decodeBody(GuestVoiceInput, ByteSize.kibibytes(80));
const decodeVoiceRef = decodeBody(VoiceSessionRef, SMALL_BODY_LIMIT);
const decodeVoiceReport = decodeBody(VoiceReportInput, ByteSize.mebibytes(1));

/** One JSON object per `data:` line, with keep-alives; ends when `events` does. */
const sse = <A>(events: Stream.Stream<A>) =>
  HttpServerResponse.stream(
    Stream.merge(
      events.pipe(Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`)),
      Stream.tick(KEEP_ALIVE).pipe(Stream.map(() => ": keep-alive\n\n")),
      { haltStrategy: "left" },
    ).pipe(Stream.map((chunk) => encoder.encode(chunk))),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    },
  );

/** Authenticates, runs the handler, and turns every failure into `{ error }` with its status. */
const guarded = <A>(
  handler: (
    request: HttpServerRequest.HttpServerRequest,
    params: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<A, GuestApiError>,
  respond: (value: A) => HttpServerResponse.HttpServerResponse,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    return respond(yield* handler(request, params));
  }).pipe(Effect.withSpan("GuestHttp.request"), (effect) =>
    effect.pipe(
      Effect.catchTags({ GuestApiError: (error) => Effect.succeed(errorResponse(error)) }),
      Effect.catchDefect((defect) =>
        Effect.logError("Guest request failed", { defect }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { error: "O servidor teve um probleminha. Tente de novo." },
              { status: 500 },
            ),
          ),
        ),
      ),
    ),
  );

const ok = (body: unknown) => HttpServerResponse.jsonUnsafe(body);

const queryParam = (url: string, name: string) =>
  new URL(url, "http://guest.invalid").searchParams.get(name);

const historyLimit = (url: string) => {
  const raw = queryParam(url, "limit");
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : GUEST_LIMITS.historyDefault;
};

/** Every route of the guest listener; nothing else is registered on its router. */
const addRoutes = Effect.fn("GuestHttp.addRoutes")(function* (router: HttpRouter.HttpRouter) {
  const service = yield* GuestService;
  const voice = yield* GuestVoice;
  const appUpdate = yield* GuestAppUpdate.make;
  const auth = (request: HttpServerRequest.HttpServerRequest) =>
    service.authenticate(request.headers["authorization"]);

  yield* router.add(
    "GET",
    GUEST_API_ROUTES.bots,
    guarded((request) => auth(request).pipe(Effect.flatMap(service.listBots)), ok),
  );
  yield* router.add(
    "GET",
    GUEST_API_ROUTES.messages,
    guarded(
      (request, params) =>
        auth(request).pipe(
          Effect.flatMap((guest) =>
            service.history(guest, params.botId ?? "", historyLimit(request.url)),
          ),
        ),
      ok,
    ),
  );
  yield* router.add(
    "POST",
    GUEST_API_ROUTES.messages,
    guarded(
      (request, params) =>
        Effect.gen(function* () {
          const guest = yield* auth(request);
          return yield* service.send(guest, params.botId ?? "", yield* decodeSend(request));
        }),
      (result) => HttpServerResponse.jsonUnsafe(result, { status: 202 }),
    ),
  );
  yield* router.add(
    "GET",
    GUEST_API_ROUTES.events,
    guarded(
      (request, params) =>
        auth(request).pipe(Effect.flatMap((guest) => service.events(guest, params.botId ?? ""))),
      sse,
    ),
  );
  yield* router.add(
    "GET",
    GUEST_API_ROUTES.attachment,
    guarded(
      (request, params) =>
        auth(request).pipe(
          Effect.flatMap((guest) =>
            service.attachment(guest, params.botId ?? "", params.attachmentId ?? ""),
          ),
        ),
      (file) =>
        HttpServerResponse.uint8Array(file.bytes, {
          contentType: file.mimeType,
          headers: { "cache-control": "private, max-age=31536000, immutable" },
        }),
    ),
  );
  yield* router.add(
    "GET",
    GUEST_API_ROUTES.html,
    guarded(
      (request, params) =>
        auth(request).pipe(
          Effect.flatMap((guest) =>
            service.html(guest, params.botId ?? "", params.attachmentId ?? ""),
          ),
        ),
      (page) =>
        HttpServerResponse.text(page.html, {
          contentType: "text/html; charset=utf-8",
          headers: {
            "content-security-policy": GUEST_HTML_CONTENT_SECURITY_POLICY,
            "x-content-type-options": "nosniff",
            "cache-control": "private, max-age=3600",
          },
        }),
    ),
  );
  yield* router.add(
    "POST",
    GUEST_API_ROUTES.pushRegister,
    guarded(
      (request) =>
        Effect.gen(function* () {
          const guest = yield* auth(request);
          return yield* service.registerPushDevice(guest, yield* decodePushRegister(request));
        }),
      ok,
    ),
  );
  yield* router.add(
    "POST",
    GUEST_API_ROUTES.pushUnregister,
    guarded(
      (request) =>
        Effect.gen(function* () {
          const guest = yield* auth(request);
          return yield* service.unregisterPushDevice(guest, yield* decodePushRef(request));
        }),
      ok,
    ),
  );
  yield* router.add(
    "POST",
    GUEST_API_ROUTES.voice,
    guarded(
      (request, params) =>
        Effect.gen(function* () {
          const guest = yield* auth(request);
          return yield* voice.session(guest, params.botId ?? "", yield* decodeVoice(request));
        }),
      sse,
    ),
  );
  yield* router.add(
    "POST",
    GUEST_API_ROUTES.voiceReady,
    guarded(
      (request) =>
        Effect.gen(function* () {
          const guest = yield* auth(request);
          return yield* voice.ready(guest, yield* decodeVoiceRef(request));
        }),
      ok,
    ),
  );
  yield* router.add(
    "POST",
    GUEST_API_ROUTES.voiceReport,
    guarded(
      (request) =>
        Effect.gen(function* () {
          const guest = yield* auth(request);
          return yield* voice.report(guest, yield* decodeVoiceReport(request));
        }),
      () => ok({}),
    ),
  );
  yield* router.add(
    "GET",
    GUEST_API_ROUTES.appUpdate,
    guarded((request) => auth(request).pipe(Effect.flatMap(appUpdate.info)), ok),
  );
  yield* router.add(
    "GET",
    GUEST_API_ROUTES.appUpdateApk,
    guarded(
      (request) =>
        auth(request).pipe(
          Effect.flatMap((guest) => appUpdate.apk(guest, queryParam(request.url, "commit"))),
        ),
      GuestAppUpdate.apkResponse,
    ),
  );
});

/**
 * The guest listener's whole HTTP app. A router of its own, never HttpRouter.serve: that one reuses
 * the main listener's memoized router, which would expose every T3 route on this port.
 */
export const makeApp = Effect.gen(function* () {
  const router = yield* HttpRouter.make;
  yield* addRoutes(router);
  // Handlers turn their own failures into answers, so what reaches here is an unknown route.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the router's own signature.
  return router.asHttpEffect().pipe(Effect.orElseSucceed(() => errorResponse(notFound())));
});

/**
 * The guest listener when `T3CODE_GUEST_LISTEN` is set; nothing otherwise. Needs GuestService and
 * GuestVoice.
 */
export const layerListener = Layer.unwrap(
  Effect.gen(function* () {
    const raw = yield* Config.String(GUEST_LISTEN_ENV).pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(raw) || raw.value.trim() === "") return Layer.empty;
    const address = parseGuestListen(raw.value);
    if (address === null) {
      yield* Effect.logWarning(`Guest API is off: ${GUEST_LISTEN_ENV} must be host:port.`);
      return Layer.empty;
    }
    const app = yield* makeApp;
    const listener = HttpServer.serve(app).pipe(
      Layer.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), address)),
      Layer.tap(() => Effect.logInfo("Guest API listening", address)),
    );
    // Production binds the tailnet address, which may not exist yet when the server starts. The
    // listener retries beside the server instead of failing (and restart-looping) all of T3.
    return Layer.effectDiscard(
      Layer.launch(listener).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Guest API could not listen; retrying in 30 seconds", {
            ...address,
            cause,
          }),
        ),
        Effect.retry(Schedule.spaced("30 seconds")),
        Effect.forkScoped,
      ),
    );
  }),
);
