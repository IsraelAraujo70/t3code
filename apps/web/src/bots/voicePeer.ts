import { readVoiceStats, type VoicePeer } from "@t3tools/client-runtime/voice";

/** Realtime requires a sending track; disabling it keeps the user's microphone muted. */
async function acquireMicrophone(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .catch((error: unknown) => {
      throw new Error(
        `Couldn't use the microphone: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  for (const track of stream.getTracks()) track.enabled = false;
  return stream;
}

/**
 * One utterance's DOM peer. It holds the microphone (the permission prompt appears on first use)
 * and its own audio element only until `close`.
 */
export async function openBrowserVoicePeer(): Promise<VoicePeer> {
  const microphone = await acquireMicrophone();
  const audio = new Audio();
  audio.autoplay = true;
  audio.muted = true;
  const pc = new RTCPeerConnection();
  for (const track of microphone.getTracks()) {
    track.enabled = false;
    pc.addTrack(track, microphone);
  }
  const channel = pc.createDataChannel("oai-events");
  let closed = false;
  const pendingWaits = new Set<() => void>();
  let listener: ((data: string) => void) | null = null;
  const messages: string[] = [];
  channel.addEventListener("message", (event) => {
    if (closed || typeof event.data !== "string") return;
    if (listener) listener(event.data);
    else messages.push(event.data);
  });
  pc.addEventListener("track", (event) => {
    if (closed) return;
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void audio.play().catch(() => {});
  });
  return {
    async createOffer() {
      await pc.setLocalDescription(await pc.createOffer());
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
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("The voice peer did not produce an SDP offer.");
      return sdp;
    },
    async accept(sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp });
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
          if (pc.connectionState === "connected") finish();
          else if (closed || pc.connectionState === "failed" || pc.connectionState === "closed")
            finish(new Error("The voice connection closed or failed."));
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
      for (const message of messages.splice(0)) {
        if (closed) break;
        next(message);
      }
    },
    setMicrophoneEnabled(enabled) {
      for (const track of microphone.getAudioTracks()) track.enabled = enabled;
    },
    setVoiceAudible(audible) {
      audio.muted = !audible;
    },
    async sample() {
      return readVoiceStats(await pc.getStats());
    },
    close() {
      if (closed) return;
      closed = true;
      listener = null;
      messages.length = 0;
      for (const cancel of pendingWaits) cancel();
      channel.close();
      pc.close();
      for (const track of microphone.getTracks()) track.stop();
      audio.pause();
      audio.srcObject = null;
    },
  };
}
