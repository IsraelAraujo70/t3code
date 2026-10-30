/**
 * The thread agent answers; realtime only relays speech. Each session owns an app-server, closed with its stream.
 */
import {
  BotsError,
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type RealtimeVoice,
  type ThreadId,
  VoiceSessionId,
  type VoiceSessionEvent,
  type VoiceReconnectAnswer,
  type VoiceReconnectInput,
  type VoiceReportInput,
  type VoiceSessionInput,
  type VoiceSessionRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import * as CodexRealtime from "./CodexRealtime.ts";
import { speakable } from "./speakable.ts";
import { VOICE_MESSAGE_PREFIX } from "./voiceMessage.ts";
import { readVoiceLanguage, VOICE_SCRIPTS, type VoiceScript } from "./voiceLanguage.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { isFromBot } from "../botSender.ts";
import { BOT_COMPACTION_MESSAGE_PREFIX } from "../compaction/botCompaction.ts";
import { awaitsAnswer } from "../threadWatch/threadWatchNotice.ts";

/** What a conversation hears from its thread, from the moment it subscribes. */
export type ThreadActivity =
  /** Whether the agent has work: a run that has not settled. The first event is the current value. */
  | { readonly type: "working"; readonly working: boolean }
  /** A run completed with this final reply. */
  | { readonly type: "reply"; readonly text: string }
  /** The agent waits on an approval or a question, which is answered only on screen. */
  | { readonly type: "waiting-on-user" };

/** The thread side of voice sessions. */
export class VoiceThreads extends Context.Service<
  VoiceThreads,
  {
    /** The message's text. Fails unless it is an assistant message of `threadId` with text. */
    readonly replyText: (
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<string, BotsError>;
    /** Posts a user message, queued behind the agent's current run. */
    readonly post: (threadId: ThreadId, text: string) => Effect.Effect<void, BotsError>;
    /** Fails when the thread does not exist. */
    readonly activity: (threadId: ThreadId) => Stream.Stream<ThreadActivity, BotsError>;
  }
>()("t3/bots/voice/VoiceSession/VoiceThreads") {}

/** How one session reaches its thread, when not the way `VoiceThreads` does. */
export interface VoiceSessionOptions {
  /** Posts what the user said instead of `VoiceThreads.post`, e.g. as a guest of the bots host. */
  readonly post?: (text: string) => Effect.Effect<void, BotsError>;
}

export class VoiceSessions extends Context.Service<
  VoiceSessions,
  {
    /** The answer once realtime is ready, then agent activity until the session ends. */
    readonly session: (
      input: VoiceSessionInput,
      options?: VoiceSessionOptions,
    ) => Stream.Stream<VoiceSessionEvent, BotsError>;
    readonly ready: (input: VoiceSessionRef) => Effect.Effect<VoiceSessionRef, BotsError>;
    /** A live conversation's realtime session, replaced with one in the current voice. */
    readonly reconnect: (
      input: VoiceReconnectInput,
    ) => Effect.Effect<VoiceReconnectAnswer, BotsError>;
    /** Writes what a client observed to the server log, to diagnose audio it did not hear. */
    readonly report: (input: VoiceReportInput) => Effect.Effect<void>;
  }
>()("t3/bots/voice/VoiceSession/VoiceSessions") {}

/** Maximum wait between the answer and `ready`. */
export const CONNECT_TIMEOUT = Duration.seconds(20);
/** Allows buffered audio to finish after a read's last speech ends. */
export const SPEECH_END_GRACE = Duration.seconds(15);
/** Bounds reads whose client never ends them. A long reply takes minutes to speak whole. */
export const MAX_READ = Duration.minutes(15);
/** Wait for the voice to start speaking appended text before appending it again. */
export const SPEECH_START_TIMEOUT = Duration.seconds(3);

/**
 * Codex cuts the middle out of appended speech over 1,000 of its estimated tokens, 4 bytes each
 * (`REALTIME_ASSISTANT_OUTPUT_TOKEN_BUDGET` in Codex 0.162), so no append may exceed this.
 */
export const CODEX_SPEECH_MAX_BYTES = 4_000;
/**
 * A reply longer than this many UTF-8 bytes is spoken in parts, one realtime turn each. Besides
 * staying under `CODEX_SPEECH_MAX_BYTES` with its framing, a shorter turn is read more faithfully,
 * and a false barge-in silences only the rest of its part.
 */
export const SPEECH_PART_BYTES = 1_000;

/** The voice when neither the setting nor `VOICE_ENV` picks one; Codex's own v3 default. */
export const DEFAULT_VOICE = "cove";
/**
 * The voice when the `voiceReaderVoice` setting is unset, read at startup. Unlike the setting it
 * is not limited to `REALTIME_VOICES`, so a newer Codex's voices stay reachable; one the installed
 * Codex does not offer falls back to Codex's default (see `RealtimeHost.startSession`).
 */
export const VOICE_ENV = "T3CODE_VOICE_READER_VOICE";

export const readVoice: Effect.Effect<string> = Config.String(VOICE_ENV).pipe(
  Config.withDefault(DEFAULT_VOICE),
  Effect.map((voice) => voice.trim().toLowerCase() || DEFAULT_VOICE),
  Effect.orElseSucceed(() => DEFAULT_VOICE),
);

/** The setting wins; unset, the voice `VOICE_ENV` picked (or the default) applies. */
const resolveVoice = (setting: RealtimeVoice | null, envVoice: string): string =>
  setting ?? envVoice;

/** How long the user stays silent before what they said goes to the agent, unless overridden. */
export const DEFAULT_TURN_SILENCE_MS = 10_000;
/** Overrides the turn window in milliseconds, read at startup. Must be a positive integer. */
export const TURN_SILENCE_ENV = "T3CODE_VOICE_TURN_SILENCE_MS";

const readTurnSilence: Effect.Effect<Duration.Duration> = Config.Int(TURN_SILENCE_ENV).pipe(
  Config.withDefault(DEFAULT_TURN_SILENCE_MS),
  Effect.orElseSucceed(() => 0),
  Effect.filterOrElse(
    (ms) => ms > 0,
    () =>
      Effect.logWarning(
        `${TURN_SILENCE_ENV} is not a positive integer; using ${DEFAULT_TURN_SILENCE_MS} ms.`,
      ).pipe(Effect.as(DEFAULT_TURN_SILENCE_MS)),
  ),
  Effect.map(Duration.millis),
);

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** Packs `pieces` into parts of at most `max` bytes, joined by `separator`. */
const pack = (pieces: ReadonlyArray<string>, separator: string, max: number): string[] => {
  const parts: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current === "" ? piece : `${current}${separator}${piece}`;
    if (byteLength(joined) <= max) current = joined;
    else {
      if (current !== "") parts.push(current);
      current = piece;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
};

/** Cuts `text` at code point boundaries into pieces of at most `max` bytes. */
const cut = (text: string, max: number): string[] => pack(Array.from(text), "", max);

/** Splits one block into pieces of at most `max` bytes: by sentence, then word, then character. */
const splitBlock = (block: string, max: number): string[] => {
  if (byteLength(block) <= max) return [block];
  // A code block is described, not read, so its start says enough.
  if (block.startsWith("```")) return [`${cut(block, max - 8)[0]}\n…\n\`\`\``];
  return block.split(/(?<=[.!?…:;])\s+/u).flatMap((sentence) =>
    byteLength(sentence) <= max
      ? [sentence]
      : pack(
          sentence.split(/\s+/u).flatMap((word) => cut(word, max)),
          " ",
          max,
        ),
  );
};

/**
 * A reply as the parts it is spoken in, each at most `max` UTF-8 bytes: paragraphs packed
 * together, a fenced code block kept whole, a long paragraph split between sentences.
 */
export const speechParts = (reply: string, max: number = SPEECH_PART_BYTES): string[] => {
  const blocks = reply
    .trim()
    .split(/(```[\s\S]*?(?:```|$))/u)
    .flatMap((chunk) => (chunk.startsWith("```") ? [chunk] : chunk.split(/\n\s*\n/u)))
    .map((block) => block.trim())
    .filter((block) => block !== "");
  const parts: string[] = [];
  for (const block of blocks) {
    const pieces = splitBlock(block, max);
    // Sentences of one paragraph rejoin with a space, paragraphs with a blank line.
    const packed = pieces.length === 1 ? pieces : pack(pieces, " ", max);
    const last = parts.at(-1);
    const [first, ...rest] = packed;
    if (first === undefined) continue;
    if (last !== undefined && byteLength(`${last}\n\n${first}`) <= max)
      parts[parts.length - 1] = `${last}\n\n${first}`;
    else parts.push(first);
    parts.push(...rest);
  }
  return parts;
};

/** A reply as the plain-speech parts the voice reads, one realtime turn each. */
const voiceParts = (reply: string, script: VoiceScript): string[] =>
  speechParts(speakable(reply, script.standIns));

/** What the voice receives for a reply, one append per part, framed in the session's language. */
export const voiceSpeeches = (reply: string, script: VoiceScript): string[] =>
  voiceParts(reply, script).map((part, index, parts) =>
    script.readSpeech(part, index, parts.length),
  );

/** Unsaid words below this many are not worth another turn. */
const RESUME_MIN_WORDS = 8;

const spokenTokens = (text: string) =>
  Array.from(text.matchAll(/[\p{L}\p{N}]+/gu), (match) => ({
    word: match[0].toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""),
    at: match.index,
  }));

/**
 * What is left of `part` when the voice ended its turn having said only `said`, from the start of
 * the sentence where it stopped; null when it said the part. The voice sometimes ends a turn
 * halfway through a part, and nothing then reads the rest. A transcript about as long as the part
 * is a reading with other words, not a stop, and is left alone.
 */
export const unsaid = (part: string, said: string): string | null => {
  const source = spokenTokens(part);
  const heard = spokenTokens(said).map((token) => token.word);
  if (heard.length >= source.length * 0.8) return null;
  // reached[i]: words of the first i source words the voice said in order (longest common subsequence).
  let previous = Array.from({ length: heard.length + 1 }, () => 0);
  const reached = [0];
  for (const { word } of source) {
    const row = [0];
    for (let j = 1; j <= heard.length; j++)
      row[j] = word === heard[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
    previous = row;
    reached.push(row[heard.length]!);
  }
  const next = reached.indexOf(reached.at(-1)!);
  const left = source.length - next;
  if (left < RESUME_MIN_WORDS || left < source.length * 0.2) return null;
  const before = part.slice(0, source[next]!.at);
  const sentence = Math.max(
    0,
    ...Array.from(before.matchAll(/[.!?…:;]\s+|\n/gu), (m) => m.index + m[0].length),
  );
  return part.slice(sentence).trim();
};

/**
 * Append speech only while realtime is quiet; mid-turn text can be folded into a silent turn or lost.
 * Buffer transcript deltas through the silence window; final transcripts can lag by seconds.
 */
export interface Handoff {
  /** The realtime session is being replaced: nothing is appended until the new one connects. */
  readonly paused: boolean;
  /** The thread has an unsettled run, or an utterance is being relayed. */
  readonly running: boolean;
  readonly voiceTalking: boolean;
  /** Speech waiting for the voice to fall quiet. */
  readonly queued: ReadonlyArray<string>;
  /** Appended and not started yet. `attempt` tells a current timeout from a stale one. */
  readonly inFlight: {
    readonly speech: string;
    readonly attempt: number;
    readonly tries: number;
  } | null;
  readonly attempts: number;
  /** What the user said since the last post. */
  readonly heard: string;
  /** Deltas of an utterance whose final transcript has not arrived yet were heard. */
  readonly transcribing: boolean;
  /** Counts silence windows started, so a window that speech restarted is told apart. */
  readonly silences: number;
}

export type HandoffInput =
  | { readonly type: "running"; readonly running: boolean }
  | { readonly type: "speak"; readonly speech: string }
  | { readonly type: "voice-talking" }
  /** The voice's turn ended; `rest` is what it left unsaid of the part it was reading. */
  | { readonly type: "voice-done"; readonly rest?: string | null }
  | { readonly type: "start-timeout"; readonly attempt: number }
  | { readonly type: "user-delta"; readonly delta: string }
  | { readonly type: "user-said"; readonly text: string }
  | { readonly type: "silence"; readonly silence: number }
  | { readonly type: "hang-up" }
  /** The realtime session is about to be replaced; it hears and says nothing more. */
  | { readonly type: "pause" }
  /** Its replacement connected. */
  | { readonly type: "resume" };

export interface HandoffStep {
  readonly state: Handoff;
  /** Speech to append now; its timeout reports `attempt`. */
  readonly append: {
    readonly speech: string;
    readonly attempt: number;
    /** The voice ignored this speech once already. */
    readonly retry: boolean;
  } | null;
  /** Speech given up on. */
  readonly lost: string | null;
  /** Start the turn window over, reporting `silence` when it passes. */
  readonly listen: number | null;
  /** The user's turn, to post now. */
  readonly post: string | null;
}

/** Appends of one speech before it is given up. */
const MAX_SPEECH_TRIES = 2;

export const idleHandoff: Handoff = {
  paused: false,
  running: false,
  voiceTalking: false,
  queued: [],
  inFlight: null,
  attempts: 0,
  heard: "",
  transcribing: false,
  silences: 0,
};

const settle = (state: Handoff, step: Partial<Omit<HandoffStep, "state">> = {}): HandoffStep => ({
  state,
  append: null,
  lost: null,
  listen: null,
  post: null,
  ...step,
});

const pump = (state: Handoff, lost: string | null = null): HandoffStep => {
  const [speech, ...rest] = state.queued;
  if (state.paused || state.voiceTalking || state.inFlight !== null || speech === undefined)
    return settle(state, { lost });
  const attempt = state.attempts + 1;
  return settle(
    { ...state, queued: rest, inFlight: { speech, attempt, tries: 1 }, attempts: attempt },
    { append: { speech, attempt, retry: false }, lost },
  );
};

const listen = (state: Handoff): HandoffStep =>
  settle({ ...state, silences: state.silences + 1 }, { listen: state.silences + 1 });

/** Utterances are joined with a space; the deltas within one carry their own spacing. */
const hear = (heard: string, text: string, startsUtterance: boolean) =>
  startsUtterance && heard.trim() !== "" ? `${heard.trimEnd()} ${text.trimStart()}` : heard + text;

const endTurn = (state: Handoff): HandoffStep => {
  const turn = state.heard.trim();
  return turn === "" ? settle(state) : settle({ ...state, heard: "" }, { post: turn });
};

export function handoffReducer(state: Handoff, input: HandoffInput): HandoffStep {
  switch (input.type) {
    case "running":
      return settle({ ...state, running: input.running });
    case "speak":
      return pump({ ...state, queued: [...state.queued, input.speech] });
    case "voice-talking":
      // Speech goes out only while the voice is quiet, so the turn that starts is speaking it.
      return settle({ ...state, voiceTalking: true, inFlight: null });
    case "voice-done":
      return pump({
        ...state,
        voiceTalking: false,
        queued: input.rest == null ? state.queued : [input.rest, ...state.queued],
      });
    case "start-timeout": {
      const inFlight = state.inFlight;
      if (inFlight === null || inFlight.attempt !== input.attempt) return settle(state);
      if (inFlight.tries >= MAX_SPEECH_TRIES)
        return pump({ ...state, inFlight: null }, inFlight.speech);
      const attempt = state.attempts + 1;
      return settle(
        {
          ...state,
          inFlight: { ...inFlight, attempt, tries: inFlight.tries + 1 },
          attempts: attempt,
        },
        { append: { speech: inFlight.speech, attempt, retry: true } },
      );
    }
    case "user-delta":
      return listen({
        ...state,
        heard: hear(state.heard, input.delta, !state.transcribing),
        transcribing: true,
      });
    case "user-said":
      // The deltas already carried this utterance, even when they were posted before it ended.
      return state.transcribing
        ? settle({ ...state, transcribing: false })
        : listen({ ...state, heard: hear(state.heard, input.text, true) });
    case "silence":
      return input.silence === state.silences ? endTurn(state) : settle(state);
    case "hang-up":
      return endTurn(state);
    case "pause":
      // Speech appended to the old session may never have started, so the new one speaks it.
      return settle({
        ...state,
        paused: true,
        voiceTalking: false,
        transcribing: false,
        inFlight: null,
        queued: state.inFlight === null ? state.queued : [state.inFlight.speech, ...state.queued],
      });
    case "resume":
      return pump({ ...state, paused: false });
  }
}

export const handoffWorking = (state: Handoff) =>
  state.running || state.inFlight !== null || state.queued.length > 0;

/** Sessions share only the lookups from session id to its `ready` and `reconnect`. */
export const layer = Layer.effect(
  VoiceSessions,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const codex = yield* CodexRealtime.CodexRealtime;
    const threads = yield* VoiceThreads;
    const settings = yield* ServerSettingsService;
    const envVoice = yield* readVoice;
    const envLanguage = yield* readVoiceLanguage;
    const turnSilence = yield* readTurnSilence;
    const readies = new Map<VoiceSessionId, Effect.Effect<void, BotsError>>();
    const reconnects = new Map<VoiceSessionId, (sdp: string) => Effect.Effect<string, BotsError>>();
    const currentVoice = settings.getSettings.pipe(
      Effect.map((current) => resolveVoice(current.voiceReaderVoice, envVoice)),
      Effect.orElseSucceed(() => envVoice),
    );
    const currentScript = settings.getSettings.pipe(
      // The setting wins; unset, the language the env picked (or English) applies.
      Effect.map((current) => current.voiceLanguage ?? envLanguage),
      Effect.orElseSucceed(() => envLanguage),
      Effect.map((language) => VOICE_SCRIPTS[language]),
    );
    return VoiceSessions.of({
      session: ({ threadId, mode, sdp, liveVoiceChange }, options = {}) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.forkIn(effect, scope);
            const text =
              mode.type === "read" ? yield* threads.replyText(threadId, mode.messageId) : null;
            // Read per realtime session, so a changed setting applies to the next one.
            let voice = yield* currentVoice;
            // Prompt and framing must agree, so the language holds for the whole session.
            const script = yield* currentScript;
            const host = yield* codex.open;
            const startRealtime = (offerSdp: string) =>
              host
                .startSession({
                  offerSdp,
                  prompt: mode.type === "read" ? script.readerPrompt : script.conversationPrompt,
                  voice,
                  delegationAckFiller: mode.type === "conversation",
                })
                .pipe(Scope.provide(scope));
            let realtime = yield* startRealtime(sdp);
            const id = VoiceSessionId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
            yield* Effect.logInfo(`Voice ${id} (${mode.type}) asked for voice ${voice}.`);
            const events = yield* Queue.unbounded<VoiceSessionEvent, BotsError | Cause.Done>();
            const end = (error: string | null) =>
              error === null
                ? Queue.end(events)
                : Queue.fail(events, new BotsError({ message: error }));
            const endAfter = (duration: Duration.Duration, ending: Effect.Effect<unknown>) =>
              fork(Effect.sleep(duration).pipe(Effect.andThen(ending)));

            let handoff = idleHandoff;
            // The plain part behind each reading appended, the one being read, and whether the
            // user spoke during the voice's turn (then it was cut short on purpose).
            const partOf = new Map<string, string>();
            let reading: string | null = null;
            let interrupted = false;
            const speakReply = (reply: string) => {
              const parts = voiceParts(reply, script);
              if (parts.length === 0 && mode.type === "read")
                return end("This reply has nothing to read aloud.").pipe(Effect.asVoid);
              return Effect.forEach(parts, (part, index) => {
                const speech = script.readSpeech(part, index, parts.length);
                partOf.set(speech, part);
                return step({ type: "speak", speech });
              });
            };
            let reported: boolean | null = null;
            let silenceTimer: Fiber.Fiber<void> | null = null;
            const postText = options.post ?? ((text: string) => threads.post(threadId, text));
            const postTurn = (turn: string) => postText(`${VOICE_MESSAGE_PREFIX}${turn}`);
            const step = (input: HandoffInput): Effect.Effect<void> =>
              Effect.suspend(() => {
                const next = handoffReducer(handoff, input);
                handoff = next.state;
                const working = handoffWorking(handoff);
                let report: Effect.Effect<unknown> = Effect.void;
                // A read reports it too, so its client waits for the reply's last part.
                if (working !== reported) {
                  reported = working;
                  report = Queue.offer(events, { type: "bot", working });
                }
                if (next.append !== null) reading = partOf.get(next.append.speech) ?? null;
                const append =
                  next.append === null
                    ? Effect.void
                    : realtime
                        .appendSpeech(
                          next.append.retry
                            ? script.retrySpeech(next.append.speech)
                            : next.append.speech,
                        )
                        .pipe(
                          Effect.andThen(
                            endAfter(
                              SPEECH_START_TIMEOUT,
                              step({ type: "start-timeout", attempt: next.append.attempt }),
                            ),
                          ),
                          Effect.catch((error) => end(error.message)),
                        );
                const lost =
                  next.lost !== null && mode.type === "read"
                    ? end("The voice did not start reading.")
                    : Effect.void;
                const silence = next.listen;
                const listen =
                  silence === null
                    ? Effect.void
                    : Effect.suspend(() =>
                        silenceTimer === null ? Effect.void : Fiber.interrupt(silenceTimer),
                      ).pipe(
                        Effect.andThen(
                          fork(
                            Effect.sleep(turnSilence).pipe(
                              // Restarting the window must not cancel a turn being posted.
                              Effect.andThen(
                                Effect.uninterruptible(step({ type: "silence", silence })),
                              ),
                            ),
                          ),
                        ),
                        Effect.map((timer) => {
                          silenceTimer = timer;
                        }),
                      );
                const post = next.post === null ? Effect.void : relay(next.post);
                return report.pipe(
                  Effect.andThen(append),
                  Effect.andThen(lost),
                  Effect.andThen(listen),
                  Effect.andThen(post),
                  Effect.asVoid,
                );
              });
            const relay = (turn: string) =>
              step({ type: "running", running: true }).pipe(
                Effect.andThen(postTurn(turn)),
                Effect.catch((error) => end(error.message)),
              );
            // Registered before the fibers below, so it runs once they have stopped hearing.
            yield* Effect.addFinalizer(() =>
              Effect.suspend(() => {
                const last = handoffReducer(handoff, { type: "hang-up" });
                handoff = last.state;
                return last.post === null
                  ? Effect.void
                  : postTurn(last.post).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning("Couldn't send what was said before hanging up.", error),
                      ),
                    );
              }),
            );

            const hear = (session: CodexRealtime.RealtimeSession) =>
              fork(
                Stream.runForEach(session.events, (event) => {
                  switch (event.type) {
                    case "transcript":
                      if (handoff.voiceTalking) return Effect.void;
                      interrupted = false;
                      return Effect.logInfo(`Voice ${id} started talking.`).pipe(
                        Effect.andThen(step({ type: "voice-talking" })),
                      );
                    case "transcript-done": {
                      // What the voice generated, to compare with what a client played.
                      const said = Effect.logInfo(`Voice ${id} said: ${event.text}`);
                      const left =
                        reading === null || interrupted ? null : unsaid(reading, event.text);
                      reading = null;
                      // Read once more from where it stopped; that reading is not resumed again.
                      const rest = left === null ? null : script.readSpeech(left, 0, 1);
                      // A whole part left unsaid frames to the same speech as the part itself.
                      if (rest !== null) partOf.delete(rest);
                      const resumed =
                        rest === null
                          ? Effect.void
                          : Effect.logInfo(`Voice ${id} stopped early; reading the rest again.`);
                      return said.pipe(
                        Effect.andThen(resumed),
                        Effect.andThen(step({ type: "voice-done", rest })),
                        Effect.andThen(
                          Effect.suspend(() =>
                            mode.type === "read" && !handoffWorking(handoff)
                              ? endAfter(SPEECH_END_GRACE, end(null))
                              : Effect.void,
                          ),
                        ),
                      );
                    }
                    // The microphone stays silent until the client is ready.
                    case "user-transcript-delta":
                      if (handoff.voiceTalking) interrupted = true;
                      return mode.type === "conversation"
                        ? step({ type: "user-delta", delta: event.delta })
                        : Effect.void;
                    case "user-transcript":
                      return mode.type === "conversation"
                        ? step({ type: "user-said", text: event.text })
                        : Effect.void;
                    case "error":
                      return end(event.message);
                    case "closed":
                      return end(null);
                  }
                }),
              );
            let hearing = yield* hear(realtime);

            // Each connect (the first peer, then each reconnect's) waits for its own `ready`.
            let connects = 1;
            let awaiting: number | null = 1;
            const awaitReady = (connect: number, failure: string) =>
              endAfter(
                CONNECT_TIMEOUT,
                Effect.suspend(() => (awaiting === connect ? end(failure) : Effect.void)),
              );
            yield* awaitReady(1, "The voice connection did not come up.");
            const start =
              text !== null
                ? speakReply(text).pipe(Effect.andThen(endAfter(MAX_READ, end(null))))
                : fork(
                    Stream.runForEach(threads.activity(threadId), (activity) => {
                      switch (activity.type) {
                        case "working":
                          return step({ type: "running", running: activity.working });
                        case "reply":
                          return speakReply(activity.text);
                        case "waiting-on-user":
                          return step({
                            type: "speak",
                            speech: script.readSpeech(script.waitingOnUser, 0, 1),
                          });
                      }
                    }).pipe(Effect.catch((error) => end(error.message))),
                  );
            readies.set(
              id,
              Effect.suspend(() => {
                const connect = awaiting;
                awaiting = null;
                if (connect === null)
                  return Effect.fail(
                    new BotsError({ message: "This voice session is already live." }),
                  );
                return connect === 1 ? start.pipe(Effect.asVoid) : step({ type: "resume" });
              }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => readies.delete(id)));

            if (mode.type === "conversation" && liveVoiceChange === true) {
              // The realtime session is stopped before its replacement starts: Codex runs one
              // realtime session per thread, and its notifications name only the thread.
              const switching = yield* Semaphore.make(1);
              let announced: string | null = null;
              const reconnect = Effect.fn("VoiceSession.reconnect")(
                function* (offerSdp: string) {
                  if (awaiting !== null)
                    return yield* new BotsError({
                      message: "This voice session is not connected yet.",
                    });
                  yield* step({ type: "pause" });
                  yield* Fiber.interrupt(hearing);
                  yield* realtime.stop;
                  voice = yield* currentVoice;
                  announced = null;
                  realtime = yield* startRealtime(offerSdp);
                  hearing = yield* hear(realtime);
                  connects += 1;
                  awaiting = connects;
                  yield* awaitReady(connects, "The voice did not come back after changing.");
                  yield* Effect.logInfo(`Voice ${id} reconnected with voice ${voice}.`);
                  return realtime.answerSdp;
                },
                (effect) =>
                  effect.pipe(
                    Effect.tapError((error) => end(error.message)),
                    Effect.uninterruptible,
                    switching.withPermits(1),
                  ),
              );
              reconnects.set(id, reconnect);
              yield* Effect.addFinalizer(() => Effect.sync(() => reconnects.delete(id)));
              yield* fork(
                Stream.runForEach(settings.streamChanges, (changed) =>
                  Effect.suspend(() => {
                    const next = resolveVoice(changed.voiceReaderVoice, envVoice);
                    if (next === voice || next === announced) return Effect.void;
                    announced = next;
                    return Queue.offer(events, { type: "voice-changed" });
                  }),
                ),
              );
            }

            const answer: VoiceSessionEvent = {
              type: "answer",
              sessionId: id,
              sdp: realtime.answerSdp,
            };
            return Stream.make(answer).pipe(Stream.concat(Stream.fromQueue(events)));
          }),
        ),
      ready: Effect.fn("VoiceSessions.ready")((input) =>
        (
          readies.get(input.sessionId) ??
          Effect.fail(new BotsError({ message: "This voice session is not waiting to connect." }))
        ).pipe(Effect.as(input)),
      ),
      reconnect: Effect.fn("VoiceSessions.reconnect")(({ sessionId, sdp }) =>
        (
          reconnects.get(sessionId)?.(sdp) ??
          Effect.fail(new BotsError({ message: "This voice session cannot change its voice." }))
        ).pipe(Effect.map((answer) => ({ sdp: answer }))),
      ),
      report: Effect.fn("VoiceSessions.report")(({ sessionId, entries }) =>
        Effect.logInfo(`Voice ${sessionId} client: ${JSON.stringify(entries)}`),
      ),
    });
  }),
).pipe(Layer.provide(NodeCrypto.layer));

const settledRunStatuses: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** Threads through the orchestrator and its projections, so a message id never crosses threads. */
export const layerThreads = Layer.effect(
  VoiceThreads,
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const crypto = yield* Crypto.Crypto;
    const notFound = () => new BotsError({ message: "This message is not in that thread." });
    const threadFailure = (cause: unknown) =>
      new BotsError({ message: "Couldn't follow this thread for voice.", cause });

    /** The final reply of a completed run the user should hear, or null. */
    const replyOf = Effect.fn("VoiceThreads.replyOf")(function* (
      threadId: ThreadId,
      run: OrchestrationV2Run,
    ) {
      if (run.status !== "completed") return null;
      if (run.userMessageId.startsWith(BOT_COMPACTION_MESSAGE_PREFIX)) return null;
      const trigger = yield* projections.getRunMessage(threadId, run.id);
      if (isFromBot(trigger?.senderThreadId)) return null;
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageRunIds: [run.id],
        messageRoles: ["assistant"],
      });
      return (
        messages
          .filter((message) => message.text.trim() !== "")
          .toSorted(
            (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
          )
          .at(-1)?.text ?? null
      );
    });

    return VoiceThreads.of({
      replyText: Effect.fn("VoiceThreads.replyText")(function* (threadId, messageId) {
        const { messages } = yield* projections
          .getThreadRecords(threadId, ["messages"], { messageIds: [messageId] })
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProjectionStoreThreadNotFoundError"
                ? notFound()
                : new BotsError({ message: "Couldn't load the message to read.", cause }),
            ),
          );
        const message = messages.find(
          (candidate) => candidate.id === messageId && candidate.threadId === threadId,
        );
        if (message === undefined) return yield* notFound();
        if (message.role !== "assistant")
          return yield* new BotsError({ message: "Only agent replies can be read aloud." });
        if (message.text.trim() === "")
          return yield* new BotsError({ message: "This reply has no text to read." });
        return message.text;
      }),
      post: Effect.fn("VoiceThreads.post")(function* (threadId, text) {
        const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        yield* engine
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:voice:${id}`),
            threadId,
            messageId: MessageId.make(`voice:${id}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.mapError(
              (cause) => new BotsError({ message: "Couldn't send what you said.", cause }),
            ),
          );
      }),
      activity: (threadId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Taken before reading the runs, so a change between the two still replays.
            const afterSequence = yield* engine.getThreadEventSequence(threadId);
            const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
            const active = new Set(
              runs.filter((run) => !settledRunStatuses.has(run.status)).map((run) => run.id),
            );
            // Replayed or repeated events must not speak twice.
            const spoken = new Set<string>();
            const once = (key: string) => (spoken.has(key) ? false : (spoken.add(key), true));
            const working = (): ThreadActivity => ({ type: "working", working: active.size > 0 });
            const changes = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
              if (event.type === "run.updated") {
                const run = event.payload;
                if (settledRunStatuses.has(run.status)) active.delete(run.id);
                else active.add(run.id);
                const reply = once(`run:${run.id}:${run.status}`)
                  ? yield* replyOf(threadId, run)
                  : null;
                return reply === null
                  ? [working()]
                  : [{ type: "reply", text: reply } satisfies ThreadActivity, working()];
              }
              if (event.type === "runtime-request.updated") {
                // Read the stored request: the event may be older than an answer already recorded.
                const stored = yield* projections.getRuntimeResponseContext(
                  threadId,
                  event.payload.id,
                );
                if (
                  awaitsAnswer(stored.request ?? event.payload) &&
                  once(`request:${event.payload.id}`)
                )
                  return [{ type: "waiting-on-user" } satisfies ThreadActivity];
              }
              return [];
            });
            return Stream.make(working()).pipe(
              Stream.concat(
                engine.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
                  Stream.mapEffect((stored) => changes(stored.event)),
                  Stream.flattenIterable,
                  Stream.mapError(threadFailure),
                ),
              ),
            );
          }).pipe(Effect.mapError(threadFailure)),
        ),
    });
  }),
).pipe(Layer.provide(NodeCrypto.layer));

/** Production thread and realtime adapters for voice sessions. */
export const layerLive = layer.pipe(
  Layer.provide(layerThreads),
  Layer.provide(CodexRealtime.layer),
  Layer.provide(ProjectionStore.layer),
);
