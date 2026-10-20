/**
 * `GET COMPUTER_STREAM_PATH`: a live view of the bots host's whole screen. The socket carries a
 * `ComputerStreamInfo` first and whenever the geometry changes, then binary JPEG frames. Each
 * frame waits for the viewer's `{"type":"ack"}` of the previous one.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthTerminalReadScope,
  COMPUTER_STREAM_PATH,
  ComputerStreamAck,
  ComputerStreamServerMessage,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../../auth/http.ts";
import { isBotsHost } from "../BotsHost.ts";
import * as ScreenCapture from "./ScreenCapture.ts";

const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder();
const encodeServerMessage = Schema.encodeSync(Schema.fromJsonString(ComputerStreamServerMessage));
const decodeAck = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerStreamAck));

const clampedInt = (
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const raw = params.get(name);
  const value = raw === null || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback;
};

/** Frame size and JPEG quality a viewer asks for with `?maxWidth=&quality=`. */
export const viewerOptions = (params: URLSearchParams): ScreenCapture.ScreenViewerOptions => ({
  maxWidth: clampedInt(params, "maxWidth", 1600, 320, 3840),
  quality: clampedInt(params, "quality", 70, 1, 100),
});

const isCaptureError = Schema.is(ScreenCapture.ScreenCaptureError);

const isAck = (chunk: Uint8Array | string) =>
  Option.isSome(decodeAck(typeof chunk === "string" ? chunk : textDecoder.decode(chunk)));

/**
 * Streams one viewer until the socket ends. At most one frame is unacknowledged; frames captured
 * meanwhile are replaced by newer ones. A capture failure is sent as `ComputerStreamError`, then
 * this returns so the caller closes the socket.
 */
export const serveViewer = <E>(
  viewer: ScreenCapture.ScreenViewer,
  send: (data: Uint8Array | string) => Effect.Effect<void, E>,
  pull: Effect.Effect<ReadonlyArray<Uint8Array | string>, E>,
) =>
  Effect.gen(function* () {
    let awaitingAck: Deferred.Deferred<void> | undefined;
    let sentInfo: ScreenCapture.ScreenFrame["info"] | undefined;
    const sendFrames = Effect.gen(function* () {
      while (true) {
        const frame = yield* viewer.next;
        if (frame.info !== sentInfo) {
          sentInfo = frame.info;
          yield* send(encodeServerMessage(frame.info));
        }
        const acked = yield* Deferred.make<void>();
        awaitingAck = acked;
        yield* send(frame.jpeg);
        yield* Deferred.await(acked);
      }
    }).pipe(
      Effect.catchIf(isCaptureError, (error) =>
        send(encodeServerMessage({ type: "error", message: error.message })),
      ),
    );
    const receive = Effect.forever(
      pull.pipe(
        Effect.flatMap((chunks) =>
          Effect.sync(() => {
            // Anything but an ack is ignored, and a batch acks at most the one frame out.
            if (awaitingAck === undefined || !chunks.some(isAck)) return;
            // Clear first: completing the ack can run the sender, which sets the next one.
            const acked = awaitingAck;
            awaitingAck = undefined;
            Deferred.doneUnsafe(acked, Exit.void);
          }),
        ),
      ),
    );
    yield* Effect.raceFirst(sendFrames, receive);
  });

const makeHandler = (screen: ScreenCapture.ScreenCapture["Service"], enabled: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!enabled || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    yield* authenticateMediaRequest(AuthTerminalReadScope);
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const options = viewerOptions(url.value.searchParams);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        // JPEGs are already compressed. Disabling deflate also keeps all
        // pending writes in the socket buffer we bound below, not a zlib queue.
        delete incoming.headers["sec-websocket-extensions"];
        const transport = incoming.socket;
        const socket = yield* request.upgrade;
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const viewer = yield* screen.attach(options);
        const send = (data: Uint8Array | string) =>
          Effect.suspend(() => {
            const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
            // A viewer that stops reading is dropped, never buffered without bound.
            if (transport.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
              return Effect.sync(() => transport.destroy()).pipe(Effect.andThen(Effect.interrupt));
            }
            return writer.write(data);
          });
        yield* serveViewer(viewer, send, reader.pull);
        yield* writer.write(new Socket.CloseEvent(1011, "screen capture failed"));
        return HttpServerResponse.empty();
      }),
    ).pipe(
      // A dropped socket is a normal end of watching.
      Effect.orElseSucceed(() => HttpServerResponse.empty()),
    );
  });

/** The route without its capture service, so tests can supply fake commands. */
export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const screen = yield* ScreenCapture.ScreenCapture;
    const enabled = yield* isBotsHost;
    yield* router.add("GET", COMPUTER_STREAM_PATH, makeHandler(screen, enabled));
  }),
);

export const routeLayer = routes.pipe(Layer.provide(ScreenCapture.layer));
