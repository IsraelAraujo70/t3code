// @effect-diagnostics globalTimers:off - The shared driver runs without an Effect runtime.
/**
 * The voice reader's client side (friend fork), shared by web and mobile: it turns the server's
 * `VoiceReaderState` snapshots into WebRTC peers. Each platform supplies `openPeer` (DOM
 * `RTCPeerConnection` on web, `react-native-webrtc` on mobile); this module owns the order of
 * offer → answer → speak → stop and never touches a platform API. See `VoiceReaderSubscribeRpc`
 * in the contracts for the server's half.
 */
import type {
  VoiceReaderAnswer,
  VoiceReaderOfferInput,
  VoiceReaderState,
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
  /** Releases the connection and its audio output. Idempotent. */
  readonly close: () => void;
}

/** The signaling RPCs, already bound to the reader's environment. Each rejects on failure. */
export interface VoiceReaderTransport {
  readonly offer: (input: VoiceReaderOfferInput) => Promise<VoiceReaderAnswer>;
  readonly speak: (input: VoiceReaderUtteranceRef) => Promise<void>;
  readonly stop: (input: VoiceReaderUtteranceRef) => Promise<void>;
}

export interface VoiceReaderDriver {
  /** Feed every state the subscription emits, in order. */
  readonly update: (state: VoiceReaderState) => void;
  /** Stops the current speech; the server moves on to the next queued reply. */
  readonly stopCurrent: () => void;
  /** Closes any open peer and ignores later updates. Ending the subscription is the caller's job. */
  readonly dispose: () => void;
}

export interface VoiceReaderDriverOptions {
  readonly openPeer: () => Promise<VoiceReaderPeer>;
  readonly transport: VoiceReaderTransport;
  /** A failed utterance; the driver has already asked the server to move on. */
  readonly onError: (message: string) => void;
  /** Wait between `turn.done` and `stop`, so the jitter buffer's last audio still plays. */
  readonly speechEndGraceMs?: number;
}

/**
 * Drives one subscription's peers: opens a peer when an utterance asks for an offer, sends the
 * offer, applies the answer, reports the peer connected, and stops the utterance when its speech
 * ends. A peer whose utterance is no longer `current` is closed. At most one peer is open.
 */
export function createVoiceReaderDriver(options: VoiceReaderDriverOptions): VoiceReaderDriver {
  type Active = {
    id: VoiceReaderUtteranceRef["utteranceId"];
    peer: VoiceReaderPeer | null;
    step: "running" | "ending" | "stopped";
    timer: ReturnType<typeof setTimeout> | null;
  };
  let active: Active | null = null;
  let disposed = false;
  const stopped = new Set<VoiceReaderUtteranceRef["utteranceId"]>();
  const isRunning = (entry: Active) => !disposed && active === entry && entry.step !== "stopped";
  const close = (entry: Active) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.peer?.close();
    entry.peer = null;
    entry.step = "stopped";
  };
  const stop = async (entry: Active) => {
    if (disposed || stopped.has(entry.id)) return;
    stopped.add(entry.id);
    try {
      await options.transport.stop({ utteranceId: entry.id });
    } catch {
      // A failed stop must not revive a locally finished peer.
    }
  };
  const run = async (entry: Active) => {
    let peer: VoiceReaderPeer | null = null;
    const stale = () => {
      if (isRunning(entry)) return false;
      peer?.close();
      return true;
    };
    try {
      peer = await options.openPeer();
      if (stale()) return;
      entry.peer = peer;
      peer.onSpeechEnd(() => {
        if (!isRunning(entry) || entry.step === "ending") return;
        entry.step = "ending";
        entry.timer = setTimeout(() => {
          if (!isRunning(entry)) return;
          close(entry);
          void stop(entry);
        }, options.speechEndGraceMs ?? 400);
      });
      const sdp = await peer.createOffer();
      if (stale()) return;
      const answer = await options.transport.offer({ utteranceId: entry.id, sdp });
      if (stale()) return;
      await peer.accept(answer.sdp);
      if (stale()) return;
      await options.transport.speak({ utteranceId: entry.id });
      stale();
    } catch (error) {
      if (stale()) return;
      close(entry);
      options.onError(error instanceof Error ? error.message : "The voice reader failed.");
      await stop(entry);
    }
  };
  return {
    update(state) {
      if (disposed) return;
      if (active && active.id !== state.current?.id) {
        close(active);
        active = null;
      }
      if (state.current?.phase !== "offer" || active || stopped.has(state.current.id)) return;
      const entry: Active = {
        id: state.current.id,
        peer: null,
        step: "running",
        timer: null,
      };
      active = entry;
      void run(entry);
    },
    stopCurrent() {
      if (disposed || !active || active.step === "stopped") return;
      close(active);
      void stop(active);
    },
    dispose() {
      disposed = true;
      if (active) close(active);
      active = null;
    },
  };
}
