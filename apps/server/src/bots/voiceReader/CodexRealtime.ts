/**
 * The voice reader's line to Codex realtime: a dedicated `codex app-server` (the `codex` provider
 * instance's binary, home and environment), never the agent sessions' app-server. Realtime is an
 * experimental app-server API, so its requests go through `client.raw.request`; its notifications
 * are in the generated catalog. Only WebRTC: the WebSocket/PCM transport needs an API key.
 */
import { BotsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

/** What one realtime session reports, in order. The stream ends after `closed`. */
export type RealtimeEvent =
  /** The voice's own words (assistant role); user-role transcripts are dropped. */
  | { readonly type: "transcript"; readonly delta: string }
  /** The voice finished generating a response; its audio may still be playing on the client. */
  | { readonly type: "transcript-done" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly reason: string | null };

export interface RealtimeSession {
  /** The remote SDP for the client's peer (`thread/realtime/sdp`). */
  readonly answerSdp: string;
  readonly events: Stream.Stream<RealtimeEvent>;
  /** `thread/realtime/appendSpeech`: the model speaks about `text` per the session prompt. */
  readonly appendSpeech: (text: string) => Effect.Effect<void, BotsError>;
  /** `thread/realtime/stop`. Idempotent; also runs when the session's scope closes. */
  readonly stop: Effect.Effect<void>;
}

export interface RealtimeHost {
  /**
   * `thread/realtime/start` over WebRTC with the client's offer, then waits for the answer SDP.
   * Sessions on one host are sequential: start the next only after the previous one stopped.
   */
  readonly startSession: (input: {
    readonly offerSdp: string;
    readonly prompt: string;
  }) => Effect.Effect<RealtimeSession, BotsError, Scope.Scope>;
}

export class CodexRealtime extends Context.Service<
  CodexRealtime,
  {
    /**
     * Spawns the app-server, initializes it with the experimental API, requires a ChatGPT login
     * (`account/read`), and starts an ephemeral thread in an isolated directory. The process lives
     * until the scope closes. Fails with a `BotsError` the user can act on.
     */
    readonly open: Effect.Effect<RealtimeHost, BotsError, Scope.Scope>;
  }
>()("t3/bots/voiceReader/CodexRealtime") {}

/** Stub until the Codex implementation lands. */
export const layer = Layer.succeed(CodexRealtime, {
  open: Effect.fail(new BotsError({ message: "The voice reader is not implemented yet." })),
});
