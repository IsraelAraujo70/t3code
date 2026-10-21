// @effect-diagnostics globalTimers:off - The shared controller runs without an Effect runtime.
/**
 * Voice sessions (friend fork), shared by web and mobile: a live conversation with a thread, or
 * one assistant reply read aloud. Each platform supplies `openPeer` (DOM `RTCPeerConnection` on
 * web, `react-native-webrtc` on mobile); this module owns the session's state machine, the audio
 * gate and the order offer → answer → ready → end, and never touches a platform API. See
 * `VoiceSessionRpc` in the contracts for the server's half.
 */
import type {
  EnvironmentId,
  MessageId,
  ThreadId,
  VoiceSessionAnswer,
  VoiceSessionId,
  VoiceSessionMode,
} from "@t3tools/contracts";

/** What the realtime voice reports on its `oai-events` data channel that a session acts on. */
export type VoiceChannelEvent =
  | { readonly type: "user-turn-started" }
  | { readonly type: "user-turn-done" }
  /** The voice handed the user's turn off; its next turn is an acknowledgement. */
  | { readonly type: "delegated" }
  /** Text arrived for the voice to speak (a reply); its next turn speaks it. */
  | { readonly type: "context-appended" }
  | { readonly type: "voice-turn-started" }
  | { readonly type: "voice-turn-done" };

/** Parses one data-channel message; null for everything a session ignores. */
export function parseVoiceChannelEvent(data: string): VoiceChannelEvent | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null || !("type" in message)) return null;
  const role =
    "turn" in message &&
    typeof message.turn === "object" &&
    message.turn !== null &&
    "role" in message.turn
      ? message.turn.role
      : null;
  switch (message.type) {
    case "turn.created":
      return role === "user"
        ? { type: "user-turn-started" }
        : role === "assistant"
          ? { type: "voice-turn-started" }
          : null;
    case "turn.done":
      return role === "user"
        ? { type: "user-turn-done" }
        : role === "assistant"
          ? { type: "voice-turn-done" }
          : null;
    case "delegation.created":
      return { type: "delegated" };
    case "session.context.appended":
      return { type: "context-appended" };
    default:
      return null;
  }
}

/**
 * Why the voice is talking. Only `ack` (right after a delegation) and `reply` (text the server
 * sent) are heard; `own` is the voice answering by itself, which the gate keeps silent.
 */
export type VoiceTurn = "ack" | "reply" | "own";

/** One session's facts. Each field changes independently; `voicePhase` derives what to show. */
export interface VoiceState {
  readonly mode: VoiceSessionMode["type"];
  readonly connection: "connecting" | "live";
  /** The user turned their microphone off. */
  readonly muted: boolean;
  readonly userSpeaking: boolean;
  /** The server reports the thread's agent has work (a run, a queued message, a relay). */
  readonly botWorking: boolean;
  /** How the voice's next turn is classified. */
  readonly expected: "ack" | "reply" | null;
  readonly voiceTurn: VoiceTurn | null;
  /**
   * A heard turn that ended while its last audio still plays: realtime reports the end of a turn
   * when it has sent the audio, not when the client has played it. `turn` tells its `played-out`.
   */
  readonly playingOut: { readonly turn: number; readonly heard: "ack" | "reply" } | null;
  /** Voice turns started so far. */
  readonly voiceTurns: number;
  /** A read finished speaking its reply. */
  readonly readDone: boolean;
}

export type VoiceInput =
  | VoiceChannelEvent
  | { readonly type: "connected" }
  | { readonly type: "bot"; readonly working: boolean }
  | { readonly type: "muted"; readonly muted: boolean }
  /** The audio of voice turn `turn` has had time to play. */
  | { readonly type: "played-out"; readonly turn: number };

/** `listening` while the user may talk (or is talking), `waiting` while the agent works. */
export type VoicePhase = "connecting" | "listening" | "waiting" | "speaking";

export function initialVoiceState(mode: VoiceSessionMode["type"]): VoiceState {
  return {
    mode,
    connection: "connecting",
    muted: false,
    userSpeaking: false,
    botWorking: false,
    expected: null,
    voiceTurn: null,
    playingOut: null,
    voiceTurns: 0,
    readDone: false,
  };
}

/** The session's state machine. Pure. */
export function voiceReducer(state: VoiceState, input: VoiceInput): VoiceState {
  switch (input.type) {
    case "connected":
      return { ...state, connection: "live" };
    case "muted":
      return {
        ...state,
        muted: input.muted,
        userSpeaking: input.muted ? false : state.userSpeaking,
      };
    case "bot":
      return { ...state, botWorking: input.working };
    case "user-turn-started":
      // Barge-in: whatever the voice was saying is cut off and stays silent until its turn ends.
      return {
        ...state,
        userSpeaking: true,
        voiceTurn: state.voiceTurn === null ? null : "own",
        playingOut: null,
      };
    case "user-turn-done":
      return { ...state, userSpeaking: false };
    case "delegated":
      return { ...state, expected: state.expected ?? "ack" };
    case "context-appended":
      return { ...state, expected: "reply" };
    case "voice-turn-started":
      return {
        ...state,
        voiceTurn: state.expected ?? "own",
        expected: null,
        playingOut: null,
        voiceTurns: state.voiceTurns + 1,
      };
    case "voice-turn-done":
      return {
        ...state,
        voiceTurn: null,
        playingOut:
          state.voiceTurn === "ack" || state.voiceTurn === "reply"
            ? { turn: state.voiceTurns, heard: state.voiceTurn }
            : null,
      };
    case "played-out":
      return state.playingOut?.turn !== input.turn
        ? state
        : {
            ...state,
            playingOut: null,
            readDone:
              state.readDone || (state.mode === "read" && state.playingOut.heard === "reply"),
          };
  }
}

/** Whether the voice's audio plays right now: the gate. */
export function voiceAudible(state: VoiceState): boolean {
  return (
    state.connection === "live" &&
    !state.userSpeaking &&
    (state.voiceTurn === "ack" || state.voiceTurn === "reply" || state.playingOut !== null)
  );
}

export function voicePhase(state: VoiceState): VoicePhase {
  if (state.connection === "connecting") return "connecting";
  if (voiceAudible(state)) return "speaking";
  if (state.userSpeaking) return "listening";
  if (state.mode === "read" || state.botWorking) return "waiting";
  return "listening";
}

/** One WebRTC peer for one session. The platform adapter builds it. */
export interface VoicePeer {
  /**
   * The local SDP offer once ICE gathering completes (or a bounded wait passes). The peer sends
   * the microphone track (silent until `setMicrophoneEnabled(true)`) and opens `oai-events`.
   */
  readonly createOffer: () => Promise<string>;
  /** Applies the answer SDP; resolves once connected, rejects if it fails or times out. */
  readonly accept: (answerSdp: string) => Promise<void>;
  /** Every `oai-events` text message, in order. */
  readonly onChannelMessage: (listener: (data: string) => void) => void;
  readonly setMicrophoneEnabled: (enabled: boolean) => void;
  /** Plays or silences the voice's audio. Idempotent. */
  readonly setVoiceAudible: (audible: boolean) => void;
  readonly levels: () => Promise<VoiceLevels>;
  /** Releases the connection, the microphone and the audio output. Idempotent. */
  readonly close: () => void;
}

/** Microphone and (audible) voice levels, 0–1. */
export interface VoiceLevels {
  readonly microphone: number;
  readonly voice: number;
}

/** A session's thread on its server, and what the session does there. */
export interface VoiceTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly mode: VoiceSessionMode;
}

/** The signaling RPCs. */
export interface VoiceTransport {
  /**
   * Opens the session stream. `onAnswer` fires once; `onBot` on each change of the agent's
   * activity; `onEnd` once when the server ends the session (`null`) or fails it (a message the
   * user can read). The returned function ends the stream early, after which none fires.
   */
  readonly session: (
    target: VoiceTarget,
    sdp: string,
    handlers: {
      readonly onAnswer: (answer: VoiceSessionAnswer) => void;
      readonly onBot: (working: boolean) => void;
      readonly onEnd: (error: string | null) => void;
    },
  ) => () => void;
  /** Rejects on failure. */
  readonly ready: (environmentId: EnvironmentId, sessionId: VoiceSessionId) => Promise<void>;
}

export interface VoiceSnapshot {
  readonly target: VoiceTarget;
  readonly phase: VoicePhase;
  readonly muted: boolean;
}

export interface VoiceController {
  /** Starts `target`; any other session ends first. */
  readonly start: (target: VoiceTarget) => void;
  /** Starts `target`, or ends it when it is the current session. */
  readonly toggle: (target: VoiceTarget) => void;
  readonly stop: () => void;
  /** Turns the user's microphone off or on; conversations only. */
  readonly setMuted: (muted: boolean) => void;
  /** The current session; a new object on every change. */
  readonly getSnapshot: () => VoiceSnapshot | null;
  readonly subscribe: (listener: () => void) => () => void;
  /** Polled while a session is live; zeros otherwise. A new object on every change. */
  readonly getLevels: () => VoiceLevels;
  readonly subscribeLevels: (listener: () => void) => () => void;
}

export interface VoiceControllerOptions {
  /** Acquires the microphone (prompting the first time) and builds the peer. */
  readonly openPeer: () => Promise<VoicePeer>;
  readonly transport: VoiceTransport;
  /** A session that failed; the controller has already released it. */
  readonly onError: (message: string) => void;
  /**
   * How long a heard turn stays audible after realtime reports its end, so the audio still in the
   * jitter buffer plays; a read ends then. Defaults to `VOICE_PLAYOUT_GRACE_MS`.
   */
  readonly speechEndGraceMs?: number;
  readonly levelIntervalMs?: number;
}

const SILENCE: VoiceLevels = { microphone: 0, voice: 0 };

/**
 * Realtime's `turn.done` arrives only 0.7–0.8 s after the last audible frame on a local wired
 * client (190 ms jitter buffer), and a phone on a worse link plays out later than that.
 */
export const VOICE_PLAYOUT_GRACE_MS = 1_500;

/** Two targets match when they talk to the same thread the same way. */
export function sameVoiceTarget(a: VoiceTarget, b: VoiceTarget): boolean {
  if (a.environmentId !== b.environmentId || a.threadId !== b.threadId) return false;
  if (a.mode.type === "read" && b.mode.type === "read")
    return a.mode.messageId === b.mode.messageId;
  return a.mode.type === b.mode.type;
}

/** The phase of the read of `messageId`, or null when that reply is not being read. */
export function voiceReadPhaseOf(
  snapshot: VoiceSnapshot | null,
  target: { environmentId: EnvironmentId; threadId: ThreadId; messageId: MessageId },
): VoicePhase | null {
  return snapshot !== null &&
    sameVoiceTarget(snapshot.target, {
      environmentId: target.environmentId,
      threadId: target.threadId,
      mode: { type: "read", messageId: target.messageId },
    })
    ? snapshot.phase
    : null;
}

/**
 * One session at a time for the whole client. Ending a session, for any reason, closes its peer
 * and its stream; a step that resolves after its session ended does nothing.
 */
export function createVoiceController(options: VoiceControllerOptions): VoiceController {
  type Session = {
    readonly target: VoiceTarget;
    state: VoiceState;
    snapshot: VoiceSnapshot;
    peer: VoicePeer | null;
    endStream: (() => void) | null;
    readonly timers: Set<ReturnType<typeof setTimeout>>;
  };
  let current: Session | null = null;
  let levels = SILENCE;
  const listeners = new Set<() => void>();
  const levelListeners = new Set<() => void>();
  const emit = (set: Set<() => void>) => {
    for (const listener of set) listener();
  };
  const setLevels = (next: VoiceLevels) => {
    if (next.microphone === levels.microphone && next.voice === levels.voice) return;
    levels = next;
    emit(levelListeners);
  };
  const finish = (session: Session, error: string | null) => {
    if (current !== session) return;
    current = null;
    for (const timer of session.timers) clearTimeout(timer);
    session.peer?.close();
    session.endStream?.();
    setLevels(SILENCE);
    emit(listeners);
    if (error !== null) options.onError(error);
  };
  const apply = (session: Session, input: VoiceInput) => {
    if (current !== session) return;
    const previous = session.state;
    const state = voiceReducer(previous, input);
    session.state = state;
    session.peer?.setVoiceAudible(voiceAudible(state));
    session.peer?.setMicrophoneEnabled(
      state.mode === "conversation" && state.connection === "live" && !state.muted,
    );
    const phase = voicePhase(state);
    if (phase !== session.snapshot.phase || state.muted !== session.snapshot.muted) {
      session.snapshot = { target: session.target, phase, muted: state.muted };
      emit(listeners);
    }
    const playingOut = state.playingOut;
    if (playingOut !== null && playingOut !== previous.playingOut) {
      const timer = setTimeout(() => {
        session.timers.delete(timer);
        apply(session, { type: "played-out", turn: playingOut.turn });
      }, options.speechEndGraceMs ?? VOICE_PLAYOUT_GRACE_MS);
      session.timers.add(timer);
    }
    if (state.readDone && !previous.readDone) finish(session, null);
  };
  const pollLevels = (session: Session, peer: VoicePeer) => {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      void peer.levels().then(
        (next) => {
          if (current !== session) return;
          // The gate silences the voice's own turns, so their level is not shown either.
          setLevels(voiceAudible(session.state) ? next : { microphone: next.microphone, voice: 0 });
          pollLevels(session, peer);
        },
        () => {
          if (current === session) pollLevels(session, peer);
        },
      );
    }, options.levelIntervalMs ?? 100);
    session.timers.add(timer);
  };
  const run = async (session: Session) => {
    const live = () => current === session;
    try {
      const peer = await options.openPeer();
      if (!live()) {
        peer.close();
        return;
      }
      session.peer = peer;
      peer.setMicrophoneEnabled(false);
      peer.setVoiceAudible(false);
      peer.onChannelMessage((data) => {
        const event = parseVoiceChannelEvent(data);
        if (event !== null) apply(session, event);
      });
      const sdp = await peer.createOffer();
      if (!live()) return;
      // Settles only while the session is live: ending it unsubscribes every handler.
      const answer = await new Promise<VoiceSessionAnswer>((resolve, reject) => {
        let answered = false;
        session.endStream = options.transport.session(session.target, sdp, {
          onAnswer: (value) => {
            answered = true;
            resolve(value);
          },
          onBot: (working) => apply(session, { type: "bot", working }),
          onEnd: (error) => {
            if (answered) finish(session, error);
            else reject(new Error(error ?? "The voice session ended before it answered."));
          },
        });
      });
      if (!live()) return;
      await peer.accept(answer.sdp);
      if (!live()) return;
      await options.transport.ready(session.target.environmentId, answer.sessionId);
      if (!live()) return;
      apply(session, { type: "connected" });
      pollLevels(session, peer);
    } catch (error) {
      finish(session, error instanceof Error ? error.message : "The voice session failed.");
    }
  };
  const stop = () => {
    if (current !== null) finish(current, null);
  };
  const start = (target: VoiceTarget) => {
    stop();
    const state = initialVoiceState(target.mode.type);
    const session: Session = {
      target,
      state,
      snapshot: { target, phase: voicePhase(state), muted: false },
      peer: null,
      endStream: null,
      timers: new Set(),
    };
    current = session;
    emit(listeners);
    void run(session);
  };
  return {
    start,
    toggle(target) {
      if (current !== null && sameVoiceTarget(current.target, target)) stop();
      else start(target);
    },
    stop,
    setMuted(muted) {
      if (current?.target.mode.type === "conversation") apply(current, { type: "muted", muted });
    },
    getSnapshot: () => current?.snapshot ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getLevels: () => levels,
    subscribeLevels(listener) {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
  };
}
