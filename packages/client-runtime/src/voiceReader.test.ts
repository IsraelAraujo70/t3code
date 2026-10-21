import { VoiceReaderUtteranceId, type VoiceReaderState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { createVoiceReaderDriver, type VoiceReaderPeer } from "./voiceReader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function snapshot(
  id: string,
  phase: "offer" | "connecting" | "speaking" = "offer",
): VoiceReaderState {
  return {
    current: { id: VoiceReaderUtteranceId.make(id), phase, transcript: "" },
    queued: 0,
    lastError: null,
  };
}

function setup() {
  const calls: string[] = [];
  const peers: ReturnType<typeof makePeer>[] = [];
  function makePeer() {
    let end = () => {};
    const peer = {
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
      close: vi.fn(),
    } satisfies VoiceReaderPeer;
    return { peer, end: () => end() };
  }
  const openPeer = vi.fn(async () => {
    calls.push("openPeer");
    const result = makePeer();
    peers.push(result);
    return result.peer;
  });
  const transport = {
    offer: vi.fn(async ({ sdp }: { sdp: string }) => {
      calls.push(`offer:${sdp}`);
      return { sdp: "answer-sdp" };
    }),
    speak: vi.fn(async () => {
      calls.push("speak");
    }),
    stop: vi.fn(async () => {
      calls.push("stop");
    }),
  };
  const onError = vi.fn();
  const driver = createVoiceReaderDriver({ openPeer, transport, onError });
  return { driver, peers, openPeer, transport, onError, calls };
}

async function flush() {
  // Each protocol stage resumes in a separate promise microtask.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

it("signals in order and stops once after the speech-end grace", async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    t.driver.update(snapshot("one"));
    await flush();
    expect(t.calls).toEqual([
      "openPeer",
      "createOffer",
      "offer:offer-sdp",
      "accept:answer-sdp",
      "speak",
    ]);
    t.peers[0]!.end();
    t.peers[0]!.end();
    await vi.advanceTimersByTimeAsync(399);
    expect(t.transport.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.transport.stop).toHaveBeenCalledTimes(1);
    expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("abandons an old offer while starting the next utterance", async () => {
  const t = setup();
  const offer = deferred<string>();
  t.driver.update(snapshot("one"));
  t.peers[0]!.peer.createOffer.mockReturnValueOnce(offer.promise);
  await flush();
  t.driver.update(snapshot("two"));
  await flush();
  offer.resolve("stale-sdp");
  await flush();
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  expect(t.transport.stop).not.toHaveBeenCalled();
  expect(t.transport.offer).toHaveBeenCalledTimes(1);
  expect(t.transport.offer).toHaveBeenCalledWith({ utteranceId: "two", sdp: "offer-sdp" });
});

it("reports a failed offer once and stops the utterance", async () => {
  const t = setup();
  t.transport.offer.mockRejectedValueOnce(new Error("offer failed"));
  t.driver.update(snapshot("one"));
  await flush();
  t.driver.update(snapshot("one"));
  t.driver.stopCurrent();
  expect(t.onError).toHaveBeenCalledExactlyOnceWith("offer failed");
  expect(t.transport.stop).toHaveBeenCalledTimes(1);
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
});

it("stops speaking immediately and ignores a later speech end", async () => {
  const t = setup();
  t.driver.update(snapshot("one"));
  await flush();
  t.driver.stopCurrent();
  t.driver.stopCurrent();
  t.peers[0]!.end();
  await flush();
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  expect(t.transport.stop).toHaveBeenCalledTimes(1);
});

it("disposes an in-flight accept without further transport calls", async () => {
  const t = setup();
  const accept = deferred<void>();
  t.driver.update(snapshot("one"));
  t.peers[0]!.peer.accept.mockReturnValueOnce(accept.promise);
  await flush();
  t.driver.dispose();
  t.driver.update(snapshot("two"));
  t.driver.stopCurrent();
  t.peers[0]!.end();
  accept.resolve();
  await flush();
  expect(t.peers[0]!.peer.close).toHaveBeenCalled();
  expect(t.openPeer).toHaveBeenCalledTimes(1);
  expect(t.transport.speak).not.toHaveBeenCalled();
  expect(t.transport.stop).not.toHaveBeenCalled();
});

it("opens one peer for repeated offer snapshots", async () => {
  const t = setup();
  t.driver.update(snapshot("one"));
  t.driver.update(snapshot("one"));
  await flush();
  t.driver.update(snapshot("one"));
  expect(t.openPeer).toHaveBeenCalledTimes(1);
});

it("ignores an unknown speaking utterance", () => {
  const t = setup();
  t.driver.update(snapshot("one", "speaking"));
  expect(t.openPeer).not.toHaveBeenCalled();
});

it("closes a peer that finishes opening after disposal", async () => {
  const opening = deferred<VoiceReaderPeer>();
  const peer: VoiceReaderPeer = {
    createOffer: vi.fn(async () => "unused"),
    accept: vi.fn(async () => {}),
    onSpeechEnd: vi.fn(),
    close: vi.fn(),
  };
  const transport = {
    offer: vi.fn(async () => ({ sdp: "unused" })),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const driver = createVoiceReaderDriver({
    openPeer: () => opening.promise,
    transport,
    onError: vi.fn(),
  });
  driver.update(snapshot("one"));
  driver.dispose();
  opening.resolve(peer);
  await flush();
  expect(peer.close).toHaveBeenCalledTimes(1);
  expect(peer.createOffer).not.toHaveBeenCalled();
  expect(transport.stop).not.toHaveBeenCalled();
});

it("swallows stop failure and uses a generic message for non-Error failures", async () => {
  const t = setup();
  t.transport.offer.mockRejectedValueOnce("failed");
  t.transport.stop.mockRejectedValueOnce(new Error("stop failed"));
  t.driver.update(snapshot("one"));
  await flush();
  t.driver.update({ current: null, queued: 0, lastError: null });
  t.driver.update(snapshot("one"));
  expect(t.onError).toHaveBeenCalledExactlyOnceWith("The voice reader failed.");
  expect(t.transport.stop).toHaveBeenCalledTimes(1);
  expect(t.openPeer).toHaveBeenCalledTimes(1);
});
