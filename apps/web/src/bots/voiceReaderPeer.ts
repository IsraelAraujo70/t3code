import type { VoiceReaderPeer } from "@t3tools/client-runtime/voice-reader";

/** Realtime requires a sending track; disabling it keeps the user's microphone muted. */
export async function acquireVoiceReaderMicrophone(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.enabled = false;
  return stream;
}

/** Releases the microphone shared by the reader's utterances. */
export function releaseVoiceReaderMicrophone(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Creates one utterance's DOM peer without taking ownership of the shared microphone. */
export function openBrowserVoiceReaderPeer({
  microphone,
  audio,
}: {
  readonly microphone: MediaStream;
  readonly audio: HTMLAudioElement;
}): VoiceReaderPeer {
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
      if (!sdp) throw new Error("The voice reader peer did not produce an SDP offer.");
      return sdp;
    },
    async accept(sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp });
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
          if (pc.connectionState === "connected") finish();
          else if (closed || pc.connectionState === "failed" || pc.connectionState === "closed")
            finish(new Error("The voice reader connection closed or failed."));
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
      audio.srcObject = null;
    },
  };
}
