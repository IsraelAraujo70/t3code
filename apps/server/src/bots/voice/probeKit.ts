/**
 * What the voice probes share: the WebRTC client they run in a headless Chromium, and how a run is
 * scored against the reply. See `voiceBench.ts` (in process) and `guest/guestVoiceProbe.ts` (over
 * the guest API).
 */
import * as Schema from "effect/Schema";

/**
 * The client in the page: a microphone track (silence, or Chromium's fake capture device when
 * `probeOffer(true)` and the browser plays a file; realtime answers nothing until the track carries
 * audio), `oai-events`, and the voice's audio measured as it plays and, on request, recorded. Plain
 * JavaScript, because the server's program has no DOM types.
 */
export const CLIENT_SCRIPT = String.raw`
window.probe = { channel: [], audible: 0, firstAudio: null, lastAudio: null, chunks: [], raw: [] };
window.probeOffer = async (useMicrophone) => {
  const probe = window.probe;
  const context = new AudioContext();
  await context.resume();
  let microphone;
  if (useMicrophone) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    microphone = stream.getAudioTracks()[0];
  } else {
    const silence = context.createMediaStreamDestination();
    const tone = context.createOscillator();
    const mute = context.createGain();
    mute.gain.value = 0;
    tone.connect(mute).connect(silence);
    tone.start();
    probe.context = context;
    probe.microphone = silence;
    microphone = silence.stream.getAudioTracks()[0];
  }
  const pc = new RTCPeerConnection();
  probe.pc = pc;
  pc.addTrack(microphone, new MediaStream([microphone]));
  pc.createDataChannel("oai-events").addEventListener("message", (message) => {
    let type = "?";
    try {
      const event = JSON.parse(String(message.data));
      type = String(event.type);
      if (probe.raw.length < 8) probe.raw.push(String(message.data).slice(0, 1500));
    } catch {}
    probe.channel.push({ t: Date.now(), type });
    if (/turn\.|delegation|context/.test(type)) console.log("probe:channel " + type);
  });
  pc.addEventListener("track", (event) => {
    const stream = new MediaStream([event.track]);
    probe.remote = stream;
    // Chrome feeds a remote track to Web Audio only while a media element plays it.
    const element = new Audio();
    element.srcObject = stream;
    element.muted = true;
    void element.play();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      if (Math.sqrt(sum / samples.length) > 0.01) {
        probe.audible += 0.05;
        probe.firstAudio ??= Date.now();
        probe.lastAudio = Date.now();
      }
    }, 50);
  });
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") resolve();
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
    setTimeout(resolve, 3000);
  });
  return pc.localDescription.sdp;
};
window.probeAccept = async (sdp) => {
  const pc = window.probe.pc;
  await pc.setRemoteDescription({ type: "answer", sdp });
  await new Promise((resolve, reject) => {
    const check = () => {
      if (pc.connectionState === "connected") resolve();
      if (pc.connectionState === "failed") reject(new Error("peer failed"));
    };
    pc.addEventListener("connectionstatechange", check);
    check();
  });
};
window.probeRecord = () => {
  const recorder = new MediaRecorder(window.probe.remote, { mimeType: "audio/webm" });
  recorder.addEventListener("dataavailable", (event) => window.probe.chunks.push(event.data));
  recorder.start(1000);
  window.probe.recorder = recorder;
};
window.probeRecording = async () => {
  const recorder = window.probe.recorder;
  if (!recorder) return null;
  await new Promise((resolve) => {
    recorder.addEventListener("stop", resolve);
    recorder.stop();
  });
  const bytes = new Uint8Array(await new Blob(window.probe.chunks).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
// Plays base64 audio into the silent microphone (from probeOffer(false)) and resolves when it ends.
window.probePlay = async (base64) => {
  const { context, microphone } = window.probe;
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const source = context.createBufferSource();
  source.buffer = await context.decodeAudioData(bytes.buffer);
  source.connect(microphone);
  await new Promise((resolve) => {
    source.addEventListener("ended", resolve);
    source.start();
  });
};
window.probeReport = () => {
  const { audible, firstAudio, lastAudio, channel, raw } = window.probe;
  return { audibleSeconds: Math.round(audible * 10) / 10, firstAudio, lastAudio, channel, raw };
};
`;

export const ClientReport = Schema.Struct({
  audibleSeconds: Schema.Number,
  firstAudio: Schema.NullOr(Schema.Number),
  lastAudio: Schema.NullOr(Schema.Number),
  channel: Schema.Array(Schema.Struct({ t: Schema.Number, type: Schema.String })),
  /** The first data channel messages, raw and cut, to see what the backend reports. */
  raw: Schema.Array(Schema.String),
});
export type ClientReport = typeof ClientReport.Type;

/** Words compared without case, accents, code blocks or links, which the voice does not read. */
export const words = (text: string) =>
  // Code and links go before accents: a backtick is a diacritic too.
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/** How many of the reply's words the voice said in order (longest common subsequence). */
export const matched = (source: ReadonlyArray<string>, said: ReadonlyArray<string>) => {
  let previous = Array.from({ length: said.length + 1 }, () => 0);
  for (const word of source) {
    const row = [0];
    for (let j = 1; j <= said.length; j++)
      row[j] = word === said[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
    previous = row;
  }
  return previous[said.length]!;
};

/** How much of `reply` the voice said, as both probes report it. */
export const scoreSpeech = (reply: string, said: string) => {
  const sourceWords = words(reply);
  const saidWords = words(said);
  const inOrder = matched(sourceWords, saidWords);
  return {
    replyWords: sourceWords.length,
    saidWords: saidWords.length,
    coverage: Math.round((inOrder / Math.max(sourceWords.length, 1)) * 1000) / 1000,
    /** Words the voice said that are not the reply's, in order. */
    addedWords: saidWords.length - inOrder,
  };
};
