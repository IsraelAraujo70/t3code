import { EnvironmentId, MessageId, ThreadId, VoiceSessionId } from "@t3tools/contracts";
import { describe, expect, it, vi, type Mock } from "vite-plus/test";
import {
  createVoiceController,
  initialVoiceState,
  parseVoiceChannelEvent,
  voiceAudible,
  voicePhase,
  voiceReadPhaseOf,
  voiceReducer,
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
    state = run(state, "voiceDone", { type: "bot", working: false });
    expect(voicePhase(state)).toBe("listening");
    expect(voiceAudible(state)).toBe(false);
  });

  it("lets the acknowledgement after a delegation through", () => {
    const state = run(live(), "userStarted", "delegated", "userDone", "voiceStarted");
    expect(voiceAudible(state)).toBe(true);
    expect(voiceAudible(run(state, "voiceDone"))).toBe(false);
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
    expect(run(read, "voiceStarted", "voiceDone").readDone).toBe(false);
    expect(run(read, "appended", "voiceStarted", "voiceDone").readDone).toBe(true);
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
      levels: async () => ({ microphone: 0.5, voice: 0.25 }),
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
  };
  const onError = vi.fn();
  const controller = createVoiceController({ openPeer, transport, onError });
  return { controller, peers, sessions, openPeer, transport, onError, calls, makePeer };
}

async function flush() {
  // Each protocol stage resumes in a separate promise microtask.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("voice controller", () => {
  it("connects in order, then follows the conversation and gates the voice", async () => {
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
    expect(phases).toEqual([
      "connecting",
      "listening",
      "waiting",
      "speaking",
      "waiting",
      "listening",
    ]);
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
    vi.useFakeTimers();
    try {
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
      await vi.advanceTimersByTimeAsync(399);
      expect(t.sessions[0]!.ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(t.sessions[0]!.ended).toHaveBeenCalledTimes(1);
      expect(peer.close).toHaveBeenCalled();
      expect(t.controller.getSnapshot()).toBeNull();
      expect(t.onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
