import {
  EnvironmentId,
  MessageId,
  ThreadId,
  VoiceReaderUtteranceId,
  type VoiceReaderAnswer,
} from "@t3tools/contracts";
import { expect, it, vi, type Mock } from "vite-plus/test";
import {
  createVoiceReaderPlayer,
  voiceReaderPhaseOf,
  type VoiceReaderPeer,
  type VoiceReaderTarget,
} from "./voiceReader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const target = (messageId: string): VoiceReaderTarget => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make(messageId),
});

type TestPeer = VoiceReaderPeer & { readonly close: Mock<() => void> };

function setup() {
  const calls: string[] = [];
  const peers: Array<{ peer: TestPeer; end: () => void }> = [];
  const reads: Array<{
    messageId: string;
    answer: (answer?: Partial<VoiceReaderAnswer>) => void;
    end: (error: string | null) => void;
    ended: ReturnType<typeof vi.fn>;
  }> = [];
  const openPeer = vi.fn<() => Promise<VoiceReaderPeer>>(async () => {
    calls.push("openPeer");
    let end = () => {};
    const peer: TestPeer = {
      createOffer: vi.fn(async () => {
        calls.push("createOffer");
        return "offer-sdp";
      }),
      accept: vi.fn(async (sdp: string) => {
        calls.push(`accept:${sdp}`);
      }),
      onSpeechEnd: (listener: () => void) => {
        end = listener;
      },
      close: vi.fn<() => void>(),
    };
    peers.push({ peer, end: () => end() });
    return peer;
  });
  const transport = {
    read: vi.fn(
      (
        readTarget: VoiceReaderTarget,
        sdp: string,
        handlers: {
          onAnswer: (answer: VoiceReaderAnswer) => void;
          onEnd: (error: string | null) => void;
        },
      ) => {
        calls.push(`read:${readTarget.messageId}:${sdp}`);
        const ended = vi.fn();
        reads.push({
          messageId: readTarget.messageId,
          answer: (answer) =>
            handlers.onAnswer({
              utteranceId: VoiceReaderUtteranceId.make(`u-${readTarget.messageId}`),
              sdp: "answer-sdp",
              ...answer,
            }),
          end: handlers.onEnd,
          ended,
        });
        return ended;
      },
    ),
    speak: vi.fn(async (_environmentId: string, ref: { utteranceId: string }) => {
      calls.push(`speak:${ref.utteranceId}`);
    }),
  };
  const onError = vi.fn();
  const player = createVoiceReaderPlayer({ openPeer, transport, onError });
  return { player, peers, reads, openPeer, transport, onError, calls };
}

async function flush() {
  // Each protocol stage resumes in a separate promise microtask.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

it("reads the message in order and ends after the speech-end grace", async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    const phases: Array<string | null> = [];
    t.player.subscribe(() => phases.push(voiceReaderPhaseOf(t.player.getSnapshot(), target("a"))));
    t.player.toggle(target("a"));
    await flush();
    t.reads[0]!.answer();
    await flush();
    expect(t.calls).toEqual([
      "openPeer",
      "createOffer",
      "read:a:offer-sdp",
      "accept:answer-sdp",
      "speak:u-a",
    ]);
    expect(phases).toEqual(["connecting", "speaking"]);
    t.peers[0]!.end();
    t.peers[0]!.end();
    await vi.advanceTimersByTimeAsync(399);
    expect(t.reads[0]!.ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.reads[0]!.ended).toHaveBeenCalledTimes(1);
    expect(t.peers[0]!.peer.close).toHaveBeenCalled();
    expect(t.player.getSnapshot()).toBeNull();
    expect(t.onError).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("stops the message being read when it is toggled again", async () => {
  const t = setup();
  t.player.toggle(target("a"));
  await flush();
  t.reads[0]!.answer();
  await flush();
  t.player.toggle(target("a"));
  expect(t.player.getSnapshot()).toBeNull();
  expect(t.reads[0]!.ended).toHaveBeenCalledTimes(1);
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  t.reads[0]!.end(null);
  expect(t.onError).not.toHaveBeenCalled();
  expect(t.openPeer).toHaveBeenCalledTimes(1);
});

it("stops the current message when another one starts", async () => {
  const t = setup();
  t.player.toggle(target("a"));
  await flush();
  t.reads[0]!.answer();
  await flush();
  t.player.toggle(target("b"));
  expect(t.reads[0]!.ended).toHaveBeenCalledTimes(1);
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  expect(voiceReaderPhaseOf(t.player.getSnapshot(), target("a"))).toBeNull();
  expect(voiceReaderPhaseOf(t.player.getSnapshot(), target("b"))).toBe("connecting");
  await flush();
  t.reads[1]!.answer();
  await flush();
  expect(voiceReaderPhaseOf(t.player.getSnapshot(), target("b"))).toBe("speaking");
  expect(t.transport.speak).toHaveBeenCalledTimes(2);
});

it("abandons a replaced message's late offer", async () => {
  const t = setup();
  const offer = deferred<string>();
  const opening = deferred<void>();
  t.openPeer.mockImplementationOnce(async () => {
    await opening.promise;
    const peer: TestPeer = {
      createOffer: vi.fn(() => offer.promise),
      accept: vi.fn(async () => {}),
      onSpeechEnd: vi.fn(),
      close: vi.fn<() => void>(),
    };
    t.peers.push({ peer, end: () => {} });
    return peer;
  });
  t.player.toggle(target("a"));
  opening.resolve();
  await flush();
  t.player.toggle(target("b"));
  offer.resolve("stale-sdp");
  await flush();
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  expect(t.transport.read).toHaveBeenCalledTimes(1);
  expect(t.transport.read.mock.calls[0]![0].messageId).toBe("b");
});

it("closes a peer that finishes opening after the reading stopped", async () => {
  const t = setup();
  const opening = deferred<VoiceReaderPeer>();
  const peer = {
    createOffer: vi.fn(async () => "unused"),
    accept: vi.fn(async () => {}),
    onSpeechEnd: vi.fn(),
    close: vi.fn(),
  };
  t.openPeer.mockReturnValueOnce(opening.promise);
  t.player.toggle(target("a"));
  t.player.stop();
  opening.resolve(peer);
  await flush();
  expect(peer.close).toHaveBeenCalledTimes(1);
  expect(peer.createOffer).not.toHaveBeenCalled();
  expect(t.transport.read).not.toHaveBeenCalled();
});

it("reports a refused microphone and a server failure before the answer", async () => {
  const t = setup();
  t.openPeer.mockRejectedValueOnce(new Error("Permission denied"));
  t.player.toggle(target("a"));
  await flush();
  expect(t.onError).toHaveBeenCalledExactlyOnceWith("Permission denied");
  expect(t.player.getSnapshot()).toBeNull();
  t.player.toggle(target("b"));
  await flush();
  t.reads[0]!.end("Only agent replies can be read aloud.");
  await flush();
  expect(t.onError).toHaveBeenLastCalledWith("Only agent replies can be read aloud.");
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  expect(t.reads[0]!.ended).toHaveBeenCalledTimes(1);
  expect(t.player.getSnapshot()).toBeNull();
});

it("ends quietly when the server ends the speech and reports a failure while speaking", async () => {
  const t = setup();
  t.player.toggle(target("a"));
  await flush();
  t.reads[0]!.answer();
  await flush();
  t.reads[0]!.end(null);
  expect(t.player.getSnapshot()).toBeNull();
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  t.player.toggle(target("b"));
  await flush();
  t.reads[1]!.answer();
  await flush();
  t.reads[1]!.end("Voice failed");
  expect(t.onError).toHaveBeenCalledExactlyOnceWith("Voice failed");
  expect(t.player.getSnapshot()).toBeNull();
});

it("reports a failed speak and ends the read", async () => {
  const t = setup();
  t.transport.speak.mockRejectedValueOnce(new Error("not waiting"));
  t.player.toggle(target("a"));
  await flush();
  t.reads[0]!.answer();
  await flush();
  expect(t.onError).toHaveBeenCalledExactlyOnceWith("not waiting");
  expect(t.reads[0]!.ended).toHaveBeenCalledTimes(1);
  expect(t.player.getSnapshot()).toBeNull();
});
