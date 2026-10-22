import { readVoiceStats, type VoicePeer } from "@t3tools/client-runtime/voice";
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
 * One voice session's native peer. It holds the microphone (Android asks for it on first use) only
 * until `close`.
 */
export async function openNativeVoicePeer(): Promise<VoicePeer> {
  const microphone = await acquireMicrophone();
  const pc = new RTCPeerConnection();
  for (const track of microphone.getTracks()) {
    track.enabled = false;
    pc.addTrack(track, microphone);
  }
  const channel = pc.createDataChannel("oai-events");
  let closed = false;
  const pendingWaits = new Set<() => void>();
  let listener: ((data: string) => void) | null = null;
  const buffered: string[] = [];
  let audible = false;
  pc.addEventListener("track", (event) => {
    if (event.track?.kind === "audio") event.track.enabled = audible;
  });
  channel.addEventListener("message", (event) => {
    if (closed || typeof event.data !== "string") return;
    if (listener) listener(event.data);
    else buffered.push(event.data);
  });
  return {
    async createOffer() {
      if (closed) throw new Error("The voice connection closed.");
      const offer: Parameters<RTCPeerConnection["setLocalDescription"]>[0] = await pc.createOffer();
      if (closed) throw new Error("The voice connection closed.");
      await pc.setLocalDescription(offer);
      if (closed) throw new Error("The voice connection closed.");
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
      if (closed) throw new Error("The voice connection closed.");
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("The voice peer did not produce an SDP offer.");
      return sdp;
    },
    async accept(sdp) {
      if (closed) throw new Error("The voice connection closed.");
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      await new Promise<void>((resolve, reject) => {
        const cancel = () => finish(new Error("The voice connection closed."));
        const finish = (error?: Error) => {
          pendingWaits.delete(cancel);
          clearTimeout(timer);
          pc.removeEventListener("connectionstatechange", changed);
          if (error) reject(error);
          else resolve();
        };
        const changed = () => {
          if (closed || pc.connectionState === "failed" || pc.connectionState === "closed")
            finish(new Error("The voice connection closed or failed."));
          else if (pc.connectionState === "connected") finish();
        };
        pendingWaits.add(cancel);
        const timer = setTimeout(
          () => finish(new Error("The voice connection timed out.")),
          15_000,
        );
        pc.addEventListener("connectionstatechange", changed);
        changed();
      });
    },
    onChannelMessage(next) {
      listener = next;
      for (const data of buffered.splice(0)) next(data);
    },
    setMicrophoneEnabled(enabled) {
      for (const track of microphone.getAudioTracks()) track.enabled = enabled;
    },
    setVoiceAudible(enabled) {
      audible = enabled;
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind === "audio") receiver.track.enabled = enabled;
      }
    },
    async sample() {
      return readVoiceStats(await pc.getStats());
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
