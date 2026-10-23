/**
 * The guest listener: its own HTTP server and router, separate from the main T3 listener, bound
 * to `T3CODE_GUEST_LISTEN` (`host:port`; production binds the tailnet address). Unset, there is
 * no guest listener.
 *
 * The router holds only GUEST_API_ROUTES, so every other path, the T3 RPC WebSocket included,
 * answers 404 here by construction. Each handler authenticates the bearer token before reading
 * anything else, decodes its input strictly, and calls one GuestService method.
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
  type GuestStreamEvent,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { GuestApiError, GuestService } from "./GuestService.ts";

export const GUEST_LISTEN_ENV = "T3CODE_GUEST_LISTEN";

const KEEP_ALIVE = "25 seconds";
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

/** Strict: unknown keys (a model, an effort, anything) fail instead of being ignored. */
const decodeBody = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Effect.fn("GuestHttp.decodeBody")(function* (request: HttpServerRequest.HttpServerRequest) {
    const body = yield* request.json.pipe(
      Effect.mapError(() => badRequest("The request body must be JSON.")),
    );
    return yield* Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" }).pipe(
      Effect.mapError((issue) => badRequest(`Invalid request: ${issue.message}`)),
    );
  });

const decodeSend = decodeBody(GuestSendInput);
const decodePushRegister = decodeBody(GuestPushDeviceInput);
const decodePushRef = decodeBody(GuestPushDeviceRef);

const sse = (events: Stream.Stream<GuestStreamEvent>) =>
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
  }).pipe(
    Effect.catchTag("GuestApiError", (error) => Effect.succeed(errorResponse(error))),
    Effect.catchDefect((defect) =>
      Effect.logError("Guest request failed", { defect }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe({ error: "Something went wrong." }, { status: 500 }),
        ),
      ),
    ),
  );

const ok = (body: unknown) => HttpServerResponse.jsonUnsafe(body);

const historyLimit = (url: string) => {
  const raw = new URL(url, "http://guest.invalid").searchParams.get("limit");
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : GUEST_LIMITS.historyDefault;
};

/** Every route of the guest listener; nothing else is registered on its router. */
export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const service = yield* GuestService;
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
  }),
);

/** The guest listener when `T3CODE_GUEST_LISTEN` is set; nothing otherwise. Needs GuestService. */
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
    yield* Effect.logInfo("Guest API listening", address);
    return HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), address)),
    );
  }),
);
