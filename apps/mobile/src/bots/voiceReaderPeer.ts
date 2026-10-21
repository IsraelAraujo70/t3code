import type { VoiceReaderPeer } from "@t3tools/client-runtime/voice-reader";
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  type MediaStream,
} from "react-native-webrtc";

/** Realtime requires a sending track; disabling it keeps the user's microphone muted. */
async function acquireMicrophone(): Promise<MediaStream> {
  // getUserMedia requests RECORD_AUDIO itself, including Android's runtime prompt.
  const stream = await mediaDevices
    .getUserMedia({ audio: true, video: false })
    .catch((error: unknown) => {
      const detail =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : String(error);
      throw new Error(`Não foi possível usar o microfone: ${detail}`);
    });
  for (const track of stream.getTracks()) track.enabled = false;
  return stream;
}

/**
 * One utterance's native peer. It holds the microphone (Android asks for it on first use) only
 * until `close`.
 */
export async function openNativeVoiceReaderPeer(): Promise<VoiceReaderPeer> {
  const microphone = await acquireMicrophone();
  const pc = new RTCPeerConnection();
  for (const track of microphone.getTracks()) {
    track.enabled = false;
    pc.addTrack(track, microphone);
  }
  const channel = pc.createDataChannel("oai-events");
  let closed = false;
  const pendingWaits = new Set<() => void>();
  let ended = false;
  let listener: (() => void) | null = null;
  let delivered = false;
  const deliver = () => {
    if (closed || !ended || !listener || delivered) return;
    delivered = true;
    listener();
  };
  channel.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const message: unknown = JSON.parse(event.data);
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "turn.done"
      ) {
        ended = true;
        deliver();
      }
    } catch {
      /* Other data-channel payloads do not affect speech completion. */
    }
  });
  return {
    async createOffer() {
      if (closed) throw new Error("The voice reader connection closed.");
      const offer: Parameters<RTCPeerConnection["setLocalDescription"]>[0] = await pc.createOffer();
      if (closed) throw new Error("The voice reader connection closed.");
      await pc.setLocalDescription(offer);
      if (closed) throw new Error("The voice reader connection closed.");
      if (pc.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const finish = () => {
            pendingWaits.delete(finish);
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", changed);
            resolve();
          };
          const changed = () => {
            if (pc.iceGatheringState === "complete") finish();
          };
          pendingWaits.add(finish);
          const timer = setTimeout(finish, 3_000);
          pc.addEventListener("icegatheringstatechange", changed);
          changed();
        });
      }
      if (closed) throw new Error("The voice reader connection closed.");
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("The voice reader peer did not produce an SDP offer.");
      return sdp;
    },
    async accept(sdp) {
      if (closed) throw new Error("The voice reader connection closed.");
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      await new Promise<void>((resolve, reject) => {
        const cancel = () => finish(new Error("The voice reader connection closed."));
        const finish = (error?: Error) => {
          pendingWaits.delete(cancel);
          clearTimeout(timer);
          pc.removeEventListener("connectionstatechange", changed);
          if (error) reject(error);
          else resolve();
        };
        const changed = () => {
          if (closed || pc.connectionState === "failed" || pc.connectionState === "closed")
            finish(new Error("The voice reader connection closed or failed."));
          else if (pc.connectionState === "connected") finish();
        };
        pendingWaits.add(cancel);
        const timer = setTimeout(
          () => finish(new Error("The voice reader connection timed out.")),
          15_000,
        );
        pc.addEventListener("connectionstatechange", changed);
        changed();
      });
    },
    onSpeechEnd(next) {
      listener = next;
      deliver();
    },
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of pendingWaits) cancel();
      channel.close();
      pc.close();
      for (const track of microphone.getTracks()) track.stop();
      microphone.release();
    },
  };
}
