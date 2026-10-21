import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import {
  getVoiceReaderEnabled,
  setVoiceReaderEnabled,
  subscribeVoiceReaderEnabled,
} from "./voiceReaderStore";

it("keeps preferences isolated by thread and environment and notifies subscribers", () => {
  const environment = EnvironmentId.make("reader-store-test");
  const otherEnvironment = EnvironmentId.make("reader-store-other");
  const thread = ThreadId.make("reader-thread");
  const otherThread = ThreadId.make("reader-other-thread");
  const listener = vi.fn();
  const unsubscribe = subscribeVoiceReaderEnabled(listener);
  expect(getVoiceReaderEnabled(environment, thread)).toBe(false);
  setVoiceReaderEnabled(environment, thread, true);
  expect(getVoiceReaderEnabled(environment, thread)).toBe(true);
  expect(getVoiceReaderEnabled(environment, otherThread)).toBe(false);
  expect(getVoiceReaderEnabled(otherEnvironment, thread)).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  setVoiceReaderEnabled(environment, thread, true);
  expect(listener).toHaveBeenCalledTimes(1);
  setVoiceReaderEnabled(environment, thread, false);
  expect(getVoiceReaderEnabled(environment, thread)).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  setVoiceReaderEnabled(environment, otherThread, true);
  expect(listener).toHaveBeenCalledTimes(2);
  setVoiceReaderEnabled(environment, otherThread, false);
});
