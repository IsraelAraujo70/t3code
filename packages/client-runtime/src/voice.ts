// @effect-diagnostics globalTimers:off - The shared controller runs without an Effect runtime.
// @effect-diagnostics globalDate:off - Diagnostics carry client wall-clock times for the server log.
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
  VoiceDiagnosticEntry,
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
  return voiceChannelEventOf(parseChannelMessage(data));
}

function parseChannelMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function voiceChannelEventOf(message: unknown): VoiceChannelEvent | null {
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
  /** One `getStats` read. */
  readonly sample: () => Promise<VoiceSample>;
  /** Releases the connection, the microphone and the audio output. Idempotent. */
  readonly close: () => void;
}

/** Microphone and (audible) voice levels, 0–1. */
export interface VoiceLevels {
  readonly microphone: number;
  readonly voice: number;
}

export interface VoiceSample {
  readonly levels: VoiceLevels;
  /** The received audio's cumulative counters (`inbound-rtp`, `media-playout`) and the RTT. */
  readonly inbound: Readonly<Record<string, number>>;
  /** The selected ICE pair, e.g. `wifi host/udp -> host/udp`; null before one is chosen. */
  readonly route: string | null;
}

/** What both platforms' `getStats` results offer: every report, in any order. */
export interface VoiceStatsReport {
  readonly forEach: (callback: (report: unknown) => void) => void;
}

/** Fields that tell late packets, lost packets and an empty jitter buffer apart. */
const INBOUND_FIELDS = [
  "packetsReceived",
  "packetsLost",
  "packetsDiscarded",
  "jitter",
  "jitterBufferDelay",
  "jitterBufferTargetDelay",
  "jitterBufferEmittedCount",
  "jitterBufferFlushes",
  "jitterBufferEmptiedCount",
  "concealedSamples",
  "silentConcealedSamples",
  "concealmentEvents",
  "delayedPacketOutageSamples",
  "insertedSamplesForDeceleration",
  "removedSamplesForAcceleration",
  "interruptionCount",
  "totalInterruptionDuration",
  "totalSamplesReceived",
  "totalSamplesDuration",
  "fecPacketsReceived",
  "audioLevel",
] as const;
const PLAYOUT_FIELDS = [
  "synthesizedSamplesDuration",
  "synthesizedSamplesEvents",
  "totalSamplesDuration",
  "totalPlayoutDelay",
  "totalSamplesCount",
] as const;

type StatsEntry = Readonly<Record<string, unknown>>;

const isStatsEntry = (value: unknown): value is StatsEntry =>
  typeof value === "object" && value !== null;
const numberOf = (entry: StatsEntry | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const stringOf = (entry: StatsEntry | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "string" ? value : null;
};
const unit = (value: number | null) => (value === null ? 0 : Math.max(0, Math.min(1, value)));
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Reads levels and the received audio's counters from one `getStats` result. Android's
 * react-native-webrtc reports `mediaType` where browsers report `kind`.
 */
export function readVoiceStats(report: VoiceStatsReport): VoiceSample {
  const byId = new Map<string, StatsEntry>();
  const all: StatsEntry[] = [];
  report.forEach((value) => {
    if (!isStatsEntry(value)) return;
    all.push(value);
    const id = stringOf(value, "id");
    if (id !== null) byId.set(id, value);
  });
  const isAudio = (entry: StatsEntry) => entry.kind === "audio" || entry.mediaType === "audio";
  const inboundEntry = all.find((entry) => entry.type === "inbound-rtp" && isAudio(entry));
  const microphone = all.find((entry) => entry.type === "media-source" && isAudio(entry));
  const playout = all.find((entry) => entry.type === "media-playout");
  const transport = all.find((entry) => entry.type === "transport");
  const selectedId = stringOf(transport, "selectedCandidatePairId");
  const pair =
    (selectedId === null ? undefined : byId.get(selectedId)) ??
    all.find(
      (entry) =>
        entry.type === "candidate-pair" && entry.nominated === true && entry.state === "succeeded",
    );
  const inbound: Record<string, number> = {};
  for (const field of INBOUND_FIELDS) {
    const value = numberOf(inboundEntry, field);
    if (value !== null) inbound[field] = round(value);
  }
  for (const field of PLAYOUT_FIELDS) {
    const value = numberOf(playout, field);
    if (value !== null) inbound[`playout.${field}`] = round(value);
  }
  const rtt = numberOf(pair, "currentRoundTripTime");
  if (rtt !== null) inbound.rtt = round(rtt);
  const candidate = (key: string) => {
    const id = stringOf(pair, key);
    const entry = id === null ? undefined : byId.get(id);
    if (entry === undefined) return "?";
    const relay = stringOf(entry, "relayProtocol");
    return `${stringOf(entry, "candidateType") ?? "?"}/${stringOf(entry, "protocol") ?? "?"}${relay === null ? "" : `/${relay}`}`;
  };
  const local = stringOf(pair, "localCandidateId");
  const network = local === null ? null : stringOf(byId.get(local), "networkType");
  return {
    levels: {
      voice: unit(numberOf(inboundEntry, "audioLevel")),
      microphone: unit(numberOf(microphone, "audioLevel")),
    },
    inbound,
    route:
      pair === undefined
        ? null
        : `${network ?? "?"} ${candidate("localCandidateId")} -> ${candidate("remoteCandidateId")}`,
  };
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
  /** Sends diagnostics to the server log. Rejects on failure; the controller ignores that. */
  readonly report: (
    environmentId: EnvironmentId,
    sessionId: VoiceSessionId,
    entries: ReadonlyArray<VoiceDiagnosticEntry>,
  ) => Promise<void>;
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
  /**
   * Polled while a session is live when `liveStats` is on; zeros otherwise. A new object on every
   * change.
   */
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
  /**
   * Whether a live session polls `sample` for levels and diagnostics. Defaults to true. Off, the
   * levels stay at zero and the session samples once as it ends, so its report still carries the
   * received audio's totals.
   */
  readonly liveStats?: boolean;
  /** How often a live session sends its diagnostics. Defaults to `VOICE_REPORT_INTERVAL_MS`. */
  readonly reportIntervalMs?: number;
}

/**
 * Every live session reports what its client observed (one stats sample per level poll, gate
 * changes, data-channel events) so audio that never played can be traced to the network, the
 * jitter buffer, or the gate from the server log.
 */
export const VOICE_REPORT_INTERVAL_MS = 5_000;
/** A batch is sent early at this size; the contract caps a batch at 1,000 entries. */
const REPORT_BATCH = 500;
/** How long an ending session waits for its last sample before releasing the peer anyway. */
const FINAL_SAMPLE_TIMEOUT_MS = 3_000;

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
    sessionId: VoiceSessionId | null;
    readonly diagnostics: VoiceDiagnosticEntry[];
    reportedAt: number;
    route: string | null;
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
  const report = (session: Session) => {
    if (session.sessionId === null || session.diagnostics.length === 0) return;
    session.reportedAt = Date.now();
    const entries = session.diagnostics.splice(0);
    void options.transport
      .report(session.target.environmentId, session.sessionId, entries)
      .catch(() => {});
  };
  const note = (session: Session, entry: VoiceDiagnosticEntry) => {
    session.diagnostics.push({ t: Date.now(), ...entry });
    if (session.diagnostics.length >= REPORT_BATCH) report(session);
  };
  const noteSample = (session: Session, sample: VoiceSample) => {
    if (sample.route !== session.route) {
      session.route = sample.route;
      if (sample.route !== null) note(session, { route: sample.route });
    }
  };
  const finish = (session: Session, error: string | null) => {
    if (current !== session) return;
    current = null;
    for (const timer of session.timers) clearTimeout(timer);
    session.endStream?.();
    setLevels(SILENCE);
    emit(listeners);
    if (error !== null) options.onError(error);
    const peer = session.peer;
    const end = () => {
      note(session, { end: error ?? "ok" });
      report(session);
      peer?.close();
    };
    if (peer === null || options.liveStats !== false || session.state.connection !== "live") {
      end();
      return;
    }
    peer.setMicrophoneEnabled(false);
    peer.setVoiceAudible(false);
    let ended = false;
    const endOnce = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      end();
    };
    const timer = setTimeout(endOnce, FINAL_SAMPLE_TIMEOUT_MS);
    void peer.sample().then((sample) => {
      if (ended) return;
      noteSample(session, sample);
      note(session, { final: true, ...sample.inbound });
      endOnce();
    }, endOnce);
  };
  const apply = (session: Session, input: VoiceInput) => {
    if (current !== session) return;
    const previous = session.state;
    const state = voiceReducer(previous, input);
    session.state = state;
    const audible = voiceAudible(state);
    if (audible !== voiceAudible(previous)) note(session, { input: input.type, audible });
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
    const interval = options.levelIntervalMs ?? 100;
    const due = Date.now() + interval;
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      const asked = Date.now();
      void peer.sample().then(
        (next) => {
          if (current !== session) return;
          const answered = Date.now();
          // `lag`: how late the poll ran; `took`: how long `getStats` took.
          note(session, { lag: asked - due, took: answered - asked, ...next.inbound });
          noteSample(session, next);
          if (
            answered - session.reportedAt >=
            (options.reportIntervalMs ?? VOICE_REPORT_INTERVAL_MS)
          )
            report(session);
          const levels = next.levels;
          // The gate silences the voice's own turns, so their level is not shown either.
          setLevels(
            voiceAudible(session.state) ? levels : { microphone: levels.microphone, voice: 0 },
          );
          pollLevels(session, peer);
        },
        () => {
          if (current === session) pollLevels(session, peer);
        },
      );
    }, interval);
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
        const message = parseChannelMessage(data);
        const type =
          typeof message === "object" && message !== null && "type" in message
            ? message.type
            : null;
        note(session, { channel: typeof type === "string" ? type.slice(0, 64) : "?" });
        const event = voiceChannelEventOf(message);
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
            session.sessionId = value.sessionId;
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
      if (options.liveStats !== false) pollLevels(session, peer);
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
      sessionId: null,
      diagnostics: [],
      reportedAt: Date.now(),
      route: null,
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
