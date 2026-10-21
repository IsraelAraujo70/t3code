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
export function createVoiceReaderDriver(_options: VoiceReaderDriverOptions): VoiceReaderDriver {
  throw new Error("createVoiceReaderDriver is not implemented yet.");
}
