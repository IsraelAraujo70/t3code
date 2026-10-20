// @effect-diagnostics globalTimers:off - The Computer viewer's socket runs outside an Effect runtime.
import {
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  COMPUTER_STREAM_PATH,
  type ComputerStreamAck,
  type ComputerStreamInfo,
  type ComputerStreamInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";
import { computerStreamRetryDelayMs, parseComputerStreamMessage } from "./computerStream.logic";

// Same access as the preview stream: cookie sessions send the cookie, bearer and DPoP sessions
// (remote, T3 Connect) carry a short-lived `wsTicket`. Re-pairing invalidates the cached ticket.
const computerStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: COMPUTER_STREAM_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`computer-stream-access:${environmentId}`)),
);

/** The stream URL with fresh credentials, or null when the environment is not connected. */
function readComputerStreamUrl(environmentId: EnvironmentId): Promise<string | null> {
  const atom = computerStreamAccessAtom(environmentId);
  // Tickets expire after a few minutes, so every (re)connect asks for a fresh one.
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.map((access) => withDeviceHubQuery(access.wsBase, access)),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}

export interface ComputerStreamEvents {
  /** First message of every connection: whether this viewer may send input. */
  readonly onAccess: (canControl: boolean) => void;
  readonly onInfo: (info: ComputerStreamInfo) => void;
  /** The server's reason; a close follows, after which the client retries. */
  readonly onError: (message: string) => void;
  /** One JPEG frame. Call `ack` once it is on screen; the server holds the next frame until then. */
  readonly onFrame: (jpeg: ArrayBuffer, ack: () => void) => void;
  /** The socket closed unexpectedly; a reconnect is scheduled. */
  readonly onDisconnected: () => void;
}

const ACK_MESSAGE = JSON.stringify({ type: "ack" } satisfies ComputerStreamAck);

export interface ComputerStreamClient {
  /** Replays input on the host; dropped while the socket is not open. */
  readonly send: (input: ComputerStreamInput) => void;
  readonly stop: () => void;
}

/**
 * Watches the bots host's screen until `stop`. Unexpected closes reconnect with a capped
 * backoff; the count resets once a connection delivers its `info`.
 */
export function createComputerStreamClient(
  environmentId: EnvironmentId,
  events: ComputerStreamEvents,
): ComputerStreamClient {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const scheduleRetry = () => {
    if (stopped) return;
    retryTimer = setTimeout(connect, computerStreamRetryDelayMs(failures++));
  };

  const connect = async () => {
    retryTimer = null;
    const url = await readComputerStreamUrl(environmentId);
    if (stopped) return;
    if (url === null) {
      scheduleRetry();
      return;
    }
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        events.onFrame(event.data, () => {
          if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(ACK_MESSAGE);
        });
        return;
      }
      if (typeof event.data !== "string") return;
      const message = parseComputerStreamMessage(event.data);
      if (message?.type === "access") {
        events.onAccess(message.canControl);
      } else if (message?.type === "info") {
        failures = 0;
        events.onInfo(message);
      } else if (message?.type === "error") {
        events.onError(message.message);
      }
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (stopped) return;
      events.onDisconnected();
      scheduleRetry();
    });
    ws.addEventListener("error", () => ws.close());
  };

  void connect();

  return {
    send: (input) => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(input));
      }
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      ws?.close();
    },
  };
}
