import { EnvironmentId, MessageId, ThreadId, VoiceSessionId } from "@t3tools/contracts";
import { describe, expect, it, vi, type Mock } from "vite-plus/test";
import {
  createVoiceController,
  initialVoiceState,
  parseVoiceChannelEvent,
  readVoiceStats,
  voiceAudible,
  voicePhase,
  voiceReadPhaseOf,
  voiceReducer,
  VOICE_PLAYOUT_GRACE_MS,
  VOICE_REPORT_INTERVAL_MS,
  type VoiceInput,
  type VoicePeer,
  type VoiceState,
  type VoiceTarget,
} from "./voice.ts";

// Data-channel payloads as Codex 0.162.1's realtime v3 sends them (recorded by the prototype).
const channel = {
  userStarted: '{"type":"turn.created","turn":{"id":"t1","role":"user","transcript":" Quanto"}}',
  userDone: '{"type":"turn.done","turn":{"id":"t1","role":"user","transcript":" Quanto é"}}',
  delegated:
    '{"type":"delegation.created","item":{"id":"i1","type":"delegation","target":"client","content":[{"type":"input_text","text":"Quanto é"}]}}',
  appended: '{"type":"session.context.appended","end_ms":1200,"start_ms":1000}',
  voiceStarted: '{"type":"turn.created","turn":{"id":"t2","role":"assistant","transcript":" Oi"}}',
  voiceDone: '{"type":"turn.done","turn":{"id":"t2","role":"assistant","transcript":" Oi."}}',
} as const;

const run = (state: VoiceState, ...inputs: ReadonlyArray<keyof typeof channel | VoiceInput>) =>
  inputs.reduce<VoiceState>((next, input) => {
    const parsed = typeof input === "string" ? parseVoiceChannelEvent(channel[input]) : input;
    if (parsed === null) throw new Error(`unparsed ${String(input)}`);
    return voiceReducer(next, parsed);
  }, state);

const playedOut = (turn: number): VoiceInput => ({ type: "played-out", turn });

const live = (mode: "conversation" | "read" = "conversation") =>
  voiceReducer(initialVoiceState(mode), { type: "connected" });

describe("parseVoiceChannelEvent", () => {
  it("maps the events a session acts on and ignores the rest", () => {
    expect(parseVoiceChannelEvent(channel.userStarted)).toEqual({ type: "user-turn-started" });
    expect(parseVoiceChannelEvent(channel.voiceDone)).toEqual({ type: "voice-turn-done" });
    expect(parseVoiceChannelEvent(channel.delegated)).toEqual({ type: "delegated" });
    expect(parseVoiceChannelEvent(channel.appended)).toEqual({ type: "context-appended" });
    expect(parseVoiceChannelEvent('{"type":"output_transcript.added","item":{}}')).toBeNull();
    expect(parseVoiceChannelEvent('{"type":"turn.created","turn":{"role":"system"}}')).toBeNull();
    expect(parseVoiceChannelEvent("not json")).toBeNull();
  });
});

describe("voice state machine", () => {
  it("goes listening, waiting, speaking the reply, and back to listening", () => {
    let state = live();
    expect(voicePhase(state)).toBe("listening");
    state = run(state, "userStarted");
    expect(voicePhase(state)).toBe("listening");
    state = run(state, "userDone", { type: "bot", working: true });
    expect(voicePhase(state)).toBe("waiting");
    state = run(state, "appended", "voiceStarted");
    expect(voicePhase(state)).toBe("speaking");
    expect(voiceAudible(state)).toBe(true);
    state = run(state, "voiceDone", { type: "bot", working: false }, playedOut(1));
    expect(voicePhase(state)).toBe("listening");
    expect(voiceAudible(state)).toBe(false);
  });

  it("lets the acknowledgement after a delegation through", () => {
    const state = run(live(), "userStarted", "delegated", "userDone", "voiceStarted");
    expect(voiceAudible(state)).toBe(true);
    expect(voiceAudible(run(state, "voiceDone", playedOut(1)))).toBe(false);
  });

  it("keeps a heard turn audible after it ends until its last audio has played", () => {
    const ended = run(live(), "appended", "voiceStarted", "voiceDone");
    expect(voiceAudible(ended)).toBe(true);
    expect(voicePhase(ended)).toBe("speaking");
    expect(voiceAudible(run(ended, playedOut(1)))).toBe(false);
    // The user talking, or the voice starting a turn of its own, cuts the rest off.
    expect(voiceAudible(run(ended, "userStarted", "userDone"))).toBe(false);
    expect(voiceAudible(run(ended, "voiceStarted"))).toBe(false);
    // A later turn's tail outlives the earlier turn's played-out.
    const next = run(ended, "appended", "voiceStarted", "voiceDone", playedOut(1));
    expect(voiceAudible(next)).toBe(true);
    // An own turn's end opens nothing.
    expect(voiceAudible(run(live(), "voiceStarted", "voiceDone"))).toBe(false);
  });

  it("keeps the voice silent when it answers by itself", () => {
    const state = run(live(), "userStarted", "userDone", { type: "bot", working: true });
    const answering = run(state, "voiceStarted");
    expect(voiceAudible(answering)).toBe(false);
    expect(voicePhase(answering)).toBe("waiting");
    // The reply that arrives next is heard again.
    expect(voiceAudible(run(answering, "voiceDone", "appended", "voiceStarted"))).toBe(true);
  });

  it("silences the voice when the user talks over it, for the rest of that turn", () => {
    const speaking = run(live(), "appended", "voiceStarted");
    const interrupted = run(speaking, "userStarted");
    expect(voiceAudible(interrupted)).toBe(false);
    expect(voicePhase(interrupted)).toBe("listening");
    expect(voiceAudible(run(interrupted, "userDone"))).toBe(false);
  });

  it("finishes a read when its reply turn ends, not when the voice talks by itself", () => {
    const read = live("read");
    expect(voicePhase(read)).toBe("waiting");
    expect(run(read, "voiceStarted", "voiceDone", playedOut(1)).readDone).toBe(false);
    const spoken = run(read, "appended", "voiceStarted", "voiceDone");
    expect(spoken.readDone).toBe(false);
    expect(run(spoken, playedOut(1)).readDone).toBe(true);
  });

  it("hears nothing before the peer is live", () => {
    expect(voiceAudible(run(initialVoiceState("read"), "appended", "voiceStarted"))).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const conversation: VoiceTarget = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  mode: { type: "conversation" },
};
const read = (messageId: string): VoiceTarget => ({
  ...conversation,
  mode: { type: "read", messageId: MessageId.make(messageId) },
});

type TestPeer = VoicePeer & {
  readonly close: Mock<() => void>;
  readonly setMicrophoneEnabled: Mock<(enabled: boolean) => void>;
  readonly setVoiceAudible: Mock<(audible: boolean) => void>;
  send: (message: keyof typeof channel) => void;
};

function setup() {
  const calls: string[] = [];
  const peers: TestPeer[] = [];
  const sessions: Array<{
    target: VoiceTarget;
    answer: () => void;
    bot: (working: boolean) => void;
    end: (error: string | null) => void;
    ended: Mock<() => void>;
  }> = [];
  const makePeer = (): TestPeer => {
    let listener: (data: string) => void = () => {};
    const peer: TestPeer = {
      createOffer: vi.fn(async () => {
        calls.push("createOffer");
        return "offer-sdp";
      }),
      accept: vi.fn(async (sdp: string) => {
        calls.push(`accept:${sdp}`);
      }),
      onChannelMessage: (next) => {
        listener = next;
      },
      setMicrophoneEnabled: vi.fn<(enabled: boolean) => void>(),
      setVoiceAudible: vi.fn<(audible: boolean) => void>(),
      sample: async () => ({
        levels: { microphone: 0.5, voice: 0.25 },
        inbound: { packetsReceived: 50, concealedSamples: 0 },
        route: "wifi host/udp -> host/udp",
      }),
      close: vi.fn<() => void>(),
      send: (message) => listener(channel[message]),
    };
    peers.push(peer);
    return peer;
  };
  const openPeer = vi.fn<() => Promise<VoicePeer>>(async () => {
    calls.push("openPeer");
    return makePeer();
  });
  const transport = {
    session: vi.fn(
      (
        target: VoiceTarget,
        sdp: string,
        handlers: Parameters<
          Parameters<typeof createVoiceController>[0]["transport"]["session"]
        >[2],
      ) => {
        calls.push(`session:${target.mode.type}:${sdp}`);
        const ended = vi.fn();
        sessions.push({
          target,
          answer: () =>
            handlers.onAnswer({
              type: "answer",
              sessionId: VoiceSessionId.make(`s${sessions.length}`),
              sdp: "answer-sdp",
            }),
          bot: handlers.onBot,
          end: handlers.onEnd,
          ended,
        });
        return ended;
      },
    ),
    ready: vi.fn(async (_environmentId: string, sessionId: string) => {
      calls.push(`ready:${sessionId}`);
    }),
    report: vi.fn(
      async (
        _environmentId: string,
        _sessionId: string,
        _entries: ReadonlyArray<Readonly<Record<string, unknown>>>,
      ) => {},
    ),
  };
  const onError = vi.fn();
  const controller = createVoiceController({ openPeer, transport, onError });
  return { controller, peers, sessions, openPeer, transport, onError, calls, makePeer };
}

function fakeTimers(): Disposable {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}

async function flush() {
  // Each protocol stage resumes in a separate promise microtask.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("voice controller", () => {
  it("connects in order, then follows the conversation and gates the voice", async () => {
    using _timers = fakeTimers();
    const t = setup();
    const phases: Array<string | undefined> = [];
    t.controller.subscribe(() => phases.push(t.controller.getSnapshot()?.phase));
    t.controller.start(conversation);
    await flush();
    t.sessions[0]!.answer();
    await flush();
    expect(t.calls).toEqual([
      "openPeer",
      "createOffer",
      "session:conversation:offer-sdp",
      "accept:answer-sdp",
      "ready:s1",
    ]);
    const peer = t.peers[0]!;
    expect(peer.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    peer.send("userStarted");
    peer.send("userDone");
    t.sessions[0]!.bot(true);
    peer.send("voiceStarted");
    expect(peer.setVoiceAudible).toHaveBeenLastCalledWith(false);
    peer.send("voiceDone");
    peer.send("appended");
    peer.send("voiceStarted");
    expect(peer.setVoiceAudible).toHaveBeenLastCalledWith(true);
    peer.send("voiceDone");
    t.sessions[0]!.bot(false);
    await vi.advanceTimersByTimeAsync(VOICE_PLAYOUT_GRACE_MS - 1);
    expect(peer.setVoiceAudible).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(peer.setVoiceAudible).toHaveBeenLastCalledWith(false);
    expect(phases).toEqual(["connecting", "listening", "waiting", "speaking", "listening"]);
  });

  it("mutes and unmutes the microphone of a conversation", async () => {
    const t = setup();
    t.controller.start(conversation);
    await flush();
    t.sessions[0]!.answer();
    await flush();
    t.controller.setMuted(true);
    expect(t.peers[0]!.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(t.controller.getSnapshot()?.muted).toBe(true);
    t.controller.setMuted(false);
    expect(t.peers[0]!.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it("reads with the microphone off and ends after the reply and its grace", async () => {
    using _timers = fakeTimers();
    const t = setup();
    const target = read("a");
    t.controller.toggle(target);
    await flush();
    t.sessions[0]!.answer();
    await flush();
    const peer = t.peers[0]!;
    expect(peer.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
    expect(
      voiceReadPhaseOf(t.controller.getSnapshot(), { ...target, messageId: MessageId.make("a") }),
    ).toBe("waiting");
    peer.send("appended");
    peer.send("voiceStarted");
    expect(t.controller.getSnapshot()?.phase).toBe("speaking");
    peer.send("voiceDone");
    await vi.advanceTimersByTimeAsync(VOICE_PLAYOUT_GRACE_MS - 1);
    expect(t.sessions[0]!.ended).not.toHaveBeenCalled();
    expect(peer.setVoiceAudible).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sessions[0]!.ended).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalled();
    expect(t.controller.getSnapshot()).toBeNull();
    expect(t.onError).not.toHaveBeenCalled();
  });

  it("stops a session toggled again and replaces one when another starts", async () => {
    const t = setup();
    t.controller.toggle(read("a"));
    await flush();
    t.sessions[0]!.answer();
    await flush();
    t.controller.toggle(read("a"));
    expect(t.controller.getSnapshot()).toBeNull();
    expect(t.sessions[0]!.ended).toHaveBeenCalledTimes(1);
    expect(t.peers[0]!.close).toHaveBeenCalled();
    t.controller.toggle(read("b"));
    await flush();
    t.controller.start(conversation);
    expect(t.sessions[1]!.ended).toHaveBeenCalledTimes(1);
    expect(t.peers[1]!.close).toHaveBeenCalled();
    expect(t.controller.getSnapshot()?.target).toBe(conversation);
    t.sessions[1]!.end(null);
    expect(t.onError).not.toHaveBeenCalled();
  });

  it("closes a peer that finishes opening after the session stopped", async () => {
    const t = setup();
    const opening = deferred<VoicePeer>();
    t.openPeer.mockReturnValueOnce(opening.promise);
    t.controller.start(conversation);
    t.controller.stop();
    const peer = t.makePeer();
    opening.resolve(peer);
    await flush();
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(peer.createOffer).not.toHaveBeenCalled();
    expect(t.transport.session).not.toHaveBeenCalled();
  });

  it("reports failures before and after the answer and a failed ready", async () => {
    const t = setup();
    t.openPeer.mockRejectedValueOnce(new Error("Permission denied"));
    t.controller.start(conversation);
    await flush();
    expect(t.onError).toHaveBeenLastCalledWith("Permission denied");
    t.controller.start(read("a"));
    await flush();
    t.sessions[0]!.end("Only agent replies can be read aloud.");
    await flush();
    expect(t.onError).toHaveBeenLastCalledWith("Only agent replies can be read aloud.");
    expect(t.sessions[0]!.ended).toHaveBeenCalledTimes(1);
    t.transport.ready.mockRejectedValueOnce(new Error("not waiting"));
    t.controller.start(conversation);
    await flush();
    t.sessions[1]!.answer();
    await flush();
    expect(t.onError).toHaveBeenLastCalledWith("not waiting");
    t.controller.start(conversation);
    await flush();
    t.sessions[2]!.answer();
    await flush();
    t.sessions[2]!.end("Realtime closed");
    expect(t.onError).toHaveBeenLastCalledWith("Realtime closed");
    expect(t.controller.getSnapshot()).toBeNull();
    expect(t.peers.every((peer) => peer.close.mock.calls.length > 0)).toBe(true);
  });

  it("reports levels while live, hiding the voice's own turns, and zeros after", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.controller.start(conversation);
      await flush();
      t.sessions[0]!.answer();
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(t.controller.getLevels()).toEqual({ microphone: 0.5, voice: 0 });
      t.peers[0]!.send("appended");
      t.peers[0]!.send("voiceStarted");
      await vi.advanceTimersByTimeAsync(100);
      expect(t.controller.getLevels()).toEqual({ microphone: 0.5, voice: 0.25 });
      t.controller.stop();
      expect(t.controller.getLevels()).toEqual({ microphone: 0, voice: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readVoiceStats", () => {
  // Shapes react-native-webrtc 155 (Android) returns: `mediaType`, ids that link the pair.
  const android = new Map<string, unknown>([
    [
      "IT01A",
      {
        id: "IT01A",
        type: "inbound-rtp",
        mediaType: "audio",
        kind: "audio",
        packetsReceived: 812,
        packetsLost: 0,
        packetsDiscarded: 37,
        jitter: 0.012345678,
        concealedSamples: 48_000,
        audioLevel: 0.4,
        codecId: "CIT01_111",
      },
    ],
    ["SA1", { id: "SA1", type: "media-source", kind: "audio", audioLevel: 0.1 }],
    ["T01", { id: "T01", type: "transport", selectedCandidatePairId: "CP1" }],
    [
      "CP1",
      {
        id: "CP1",
        type: "candidate-pair",
        localCandidateId: "L1",
        remoteCandidateId: "R1",
        currentRoundTripTime: 0.183,
      },
    ],
    [
      "L1",
      {
        id: "L1",
        type: "local-candidate",
        networkType: "wifi",
        candidateType: "srflx",
        protocol: "udp",
      },
    ],
    ["R1", { id: "R1", type: "remote-candidate", candidateType: "host", protocol: "udp" }],
  ]);

  it("reads levels, the inbound audio counters and the selected route", () => {
    expect(readVoiceStats(android)).toEqual({
      levels: { voice: 0.4, microphone: 0.1 },
      inbound: {
        packetsReceived: 812,
        packetsLost: 0,
        packetsDiscarded: 37,
        jitter: 0.0123,
        concealedSamples: 48_000,
        audioLevel: 0.4,
        rtt: 0.183,
      },
      route: "wifi srflx/udp -> host/udp",
    });
  });

  it("falls back to the nominated pair and reports nothing it cannot find", () => {
    const browser = new Map<string, unknown>([
      ["v", { id: "v", type: "inbound-rtp", kind: "video", packetsReceived: 9 }],
      ["p", { id: "p", type: "candidate-pair", nominated: true, state: "succeeded" }],
      ["junk", null],
    ]);
    expect(readVoiceStats(browser)).toEqual({
      levels: { voice: 0, microphone: 0 },
      inbound: {},
      route: "? ? -> ?",
    });
    expect(readVoiceStats(new Map())).toEqual({
      levels: { voice: 0, microphone: 0 },
      inbound: {},
      route: null,
    });
  });
});

describe("voice diagnostics", () => {
  it("reports samples, the route, gate changes and channel events, then the end", async () => {
    using _timers = fakeTimers();
    const t = setup();
    t.controller.start(conversation);
    await flush();
    t.sessions[0]!.answer();
    await flush();
    const peer = t.peers[0]!;
    peer.send("appended");
    peer.send("voiceStarted");
    await vi.advanceTimersByTimeAsync(VOICE_REPORT_INTERVAL_MS);
    expect(t.transport.report).toHaveBeenCalledTimes(1);
    const [environmentId, sessionId, first] = t.transport.report.mock.calls[0]!;
    expect([environmentId, sessionId]).toEqual(["env", "s1"]);
    const keyed = (key: string) => first.filter((entry) => key in entry);
    expect(keyed("channel").map((entry) => entry.channel)).toEqual([
      "session.context.appended",
      "turn.created",
    ]);
    expect(keyed("audible")).toEqual([
      expect.objectContaining({ input: "voice-turn-started", audible: true }),
    ]);
    expect(keyed("route")).toEqual([
      expect.objectContaining({ route: "wifi host/udp -> host/udp" }),
    ]);
    // One sample per level poll, each with its counters and timing.
    expect(keyed("packetsReceived").length).toBeGreaterThanOrEqual(40);
    expect(keyed("packetsReceived")[0]).toEqual(
      expect.objectContaining({ lag: 0, took: 0, concealedSamples: 0 }),
    );
    expect(first.every((entry) => typeof entry.t === "number")).toBe(true);
    // Hanging up sends what is left, ending with how the session ended.
    peer.send("voiceDone");
    t.controller.stop();
    expect(t.transport.report).toHaveBeenCalledTimes(2);
    const last = t.transport.report.mock.calls[1]![2];
    expect(last.at(-1)).toEqual(expect.objectContaining({ end: "ok" }));
    expect(last.some((entry) => entry.channel === "turn.done")).toBe(true);
  });

  it("keeps a failed report from affecting the session", async () => {
    using _timers = fakeTimers();
    const t = setup();
    t.transport.report.mockRejectedValue(new Error("offline"));
    t.controller.start(conversation);
    await flush();
    t.sessions[0]!.answer();
    await flush();
    await vi.advanceTimersByTimeAsync(VOICE_REPORT_INTERVAL_MS * 2);
    expect(t.transport.report).toHaveBeenCalled();
    expect(t.controller.getSnapshot()?.phase).toBe("listening");
    expect(t.onError).not.toHaveBeenCalled();
  });
});
