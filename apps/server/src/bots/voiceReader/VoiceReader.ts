/**
 * The voice reader: speaks each completed run's final assistant reply of a subscribed thread
 * through Codex realtime. See `VoiceReaderSubscribeRpc` in the contracts for the protocol.
 * One app-server per subscription, one realtime session per reply.
 */
import {
  BotsError,
  type ThreadId,
  type VoiceReaderAnswer,
  type VoiceReaderOfferInput,
  type VoiceReaderState,
  type VoiceReaderSubscribeInput,
  type VoiceReaderUtteranceRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** One reply to speak: the final assistant text of a run that completed. */
export interface VoiceReaderReply {
  readonly runId: string;
  readonly text: string;
}

/** Replies of runs that complete from now on; never replays older runs. */
export class VoiceReaderReplies extends Context.Service<
  VoiceReaderReplies,
  {
    readonly completed: (threadId: ThreadId) => Stream.Stream<VoiceReaderReply>;
  }
>()("t3/bots/voiceReader/VoiceReader/VoiceReaderReplies") {}

export class VoiceReader extends Context.Service<
  VoiceReader,
  {
    /** The reader's state, first once Codex is ready, then on every change. */
    readonly subscribe: (
      input: VoiceReaderSubscribeInput,
    ) => Stream.Stream<VoiceReaderState, BotsError>;
    readonly offer: (input: VoiceReaderOfferInput) => Effect.Effect<VoiceReaderAnswer, BotsError>;
    readonly speak: (
      input: VoiceReaderUtteranceRef,
    ) => Effect.Effect<VoiceReaderUtteranceRef, BotsError>;
    readonly stop: (
      input: VoiceReaderUtteranceRef,
    ) => Effect.Effect<VoiceReaderUtteranceRef, BotsError>;
  }
>()("t3/bots/voiceReader/VoiceReader") {}

const notYet = new BotsError({ message: "The voice reader is not implemented yet." });

/** Stub until the service lands. */
export const layer = Layer.succeed(VoiceReader, {
  subscribe: () => Stream.fail(notYet),
  offer: () => Effect.fail(notYet),
  speak: () => Effect.fail(notYet),
  stop: () => Effect.fail(notYet),
});
