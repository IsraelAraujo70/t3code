// @effect-diagnostics globalTimers:off - The shared player runs without an Effect runtime.
/**
 * The voice reader's client side (friend fork), shared by web and mobile: reads one assistant
 * message aloud at a time. Each platform supplies `openPeer` (DOM `RTCPeerConnection` on web,
 * `react-native-webrtc` on mobile); this module owns the order of offer → answer → speak → end and
 * never touches a platform API. See `VoiceReaderReadRpc` in the contracts for the server's half.
 */
import type {
  EnvironmentId,
  MessageId,
  ThreadId,
  VoiceReaderAnswer,
  VoiceReaderUtteranceRef,
} from "@t3tools/contracts";

/** One WebRTC peer for one utterance. The platform adapter builds it. */
export interface VoiceReaderPeer {
  /**
   * The local SDP offer once ICE gathering completes (or a bounded wait passes). The peer sends a
   * muted microphone track and opens the `oai-events` data channel: a receive-only peer stays
   * silent.
   */
  readonly createOffer: () => Promise<string>;
  /** Applies the answer SDP; resolves once the peer is connected, rejects if it fails or times out. */
  readonly accept: (answerSdp: string) => Promise<void>;
  /** Calls `listener` once when the data channel reports the spoken response ended (`turn.done`). */
  readonly onSpeechEnd: (listener: () => void) => void;
  /** Releases the connection, the microphone and the audio output. Idempotent. */
  readonly close: () => void;
}

/** The message to read, on its own server. */
export interface VoiceReaderTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** The signaling RPCs. */
export interface VoiceReaderTransport {
  /**
   * Opens the read stream. `onAnswer` fires once with the server's answer; `onEnd` fires once when
   * the server ends the utterance (`null`) or fails it (a message the user can read). The returned
   * function ends the stream early, after which neither fires.
   */
  readonly read: (
    target: VoiceReaderTarget,
    sdp: string,
    handlers: {
      readonly onAnswer: (answer: VoiceReaderAnswer) => void;
      readonly onEnd: (error: string | null) => void;
    },
  ) => () => void;
  /** Rejects on failure. */
  readonly speak: (environmentId: EnvironmentId, ref: VoiceReaderUtteranceRef) => Promise<void>;
}

/** `connecting` covers the microphone prompt, signaling and the peer coming up. */
export type VoiceReaderPhase = "connecting" | "speaking";

export interface VoiceReaderPlayback {
  readonly target: VoiceReaderTarget;
  readonly phase: VoiceReaderPhase;
}

export interface VoiceReaderPlayer {
  /** Reads `target`, or stops it when it is the one being read. Any other reading stops first. */
  readonly toggle: (target: VoiceReaderTarget) => void;
  readonly stop: () => void;
  /** The reading in progress; a new object on every change. */
  readonly getSnapshot: () => VoiceReaderPlayback | null;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface VoiceReaderPlayerOptions {
  /** Acquires the microphone (prompting the first time) and builds the peer. */
  readonly openPeer: () => Promise<VoiceReaderPeer>;
  readonly transport: VoiceReaderTransport;
  /** A reading that failed; the player has already released it. */
  readonly onError: (message: string) => void;
  /** Wait between `turn.done` and ending the read, so the jitter buffer's last audio still plays. */
  readonly speechEndGraceMs?: number;
}

/** The phase of `target` in `playback`, or null when another message (or none) is being read. */
export function voiceReaderPhaseOf(
  playback: VoiceReaderPlayback | null,
  target: VoiceReaderTarget,
): VoiceReaderPhase | null {
  return playback !== null && sameTarget(playback.target, target) ? playback.phase : null;
}

function sameTarget(a: VoiceReaderTarget, b: VoiceReaderTarget): boolean {
  return (
    a.environmentId === b.environmentId && a.threadId === b.threadId && a.messageId === b.messageId
  );
}

/**
 * One reading at a time for the whole client. Ending a reading, for any reason, closes its peer
 * and its read stream; a step that resolves after its reading ended does nothing.
 */
export function createVoiceReaderPlayer(options: VoiceReaderPlayerOptions): VoiceReaderPlayer {
  type Reading = {
    playback: VoiceReaderPlayback;
    peer: VoiceReaderPeer | null;
    endRead: (() => void) | null;
    timer: ReturnType<typeof setTimeout> | null;
  };
  let current: Reading | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const finish = (reading: Reading, error: string | null) => {
    if (current !== reading) return;
    current = null;
    if (reading.timer !== null) clearTimeout(reading.timer);
    reading.peer?.close();
    reading.endRead?.();
    emit();
    if (error !== null) options.onError(error);
  };
  const run = async (reading: Reading) => {
    const live = () => current === reading;
    try {
      const peer = await options.openPeer();
      if (!live()) {
        peer.close();
        return;
      }
      reading.peer = peer;
      peer.onSpeechEnd(() => {
        if (!live() || reading.timer !== null) return;
        reading.timer = setTimeout(() => finish(reading, null), options.speechEndGraceMs ?? 400);
      });
      const sdp = await peer.createOffer();
      if (!live()) return;
      // Settles only while the reading is live: ending it unsubscribes both handlers.
      const answer = await new Promise<VoiceReaderAnswer>((resolve, reject) => {
        let answered = false;
        reading.endRead = options.transport.read(reading.playback.target, sdp, {
          onAnswer: (value) => {
            answered = true;
            resolve(value);
          },
          onEnd: (error) => {
            if (answered) finish(reading, error);
            else reject(new Error(error ?? "The voice reader ended before it answered."));
          },
        });
      });
      if (!live()) return;
      await peer.accept(answer.sdp);
      if (!live()) return;
      await options.transport.speak(reading.playback.target.environmentId, {
        utteranceId: answer.utteranceId,
      });
      if (!live()) return;
      reading.playback = { ...reading.playback, phase: "speaking" };
      emit();
    } catch (error) {
      finish(reading, error instanceof Error ? error.message : "The voice reader failed.");
    }
  };
  const stop = () => {
    if (current !== null) finish(current, null);
  };
  return {
    toggle(target) {
      const reading = current;
      stop();
      if (reading !== null && sameTarget(reading.playback.target, target)) return;
      const next: Reading = {
        playback: { target, phase: "connecting" },
        peer: null,
        endRead: null,
        timer: null,
      };
      current = next;
      emit();
      void run(next);
    },
    stop,
    getSnapshot: () => current?.playback ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
