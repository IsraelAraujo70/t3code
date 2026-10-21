import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

const enabledThreads = new Map<EnvironmentId, Set<ThreadId>>();
const listeners = new Set<() => void>();

/** Observes changes to client-local reader preferences. */
export function subscribeVoiceReaderEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads one thread's preference without starting an audio session. */
export function getVoiceReaderEnabled(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return enabledThreads.get(environmentId)?.has(threadId) ?? false;
}

/** Changes one thread's preference for the lifetime of this page. */
export function setVoiceReaderEnabled(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  enabled: boolean,
): void {
  if (getVoiceReaderEnabled(environmentId, threadId) === enabled) return;
  if (enabled) {
    let threads = enabledThreads.get(environmentId);
    if (!threads) {
      threads = new Set();
      enabledThreads.set(environmentId, threads);
    }
    threads.add(threadId);
  } else {
    const threads = enabledThreads.get(environmentId);
    threads?.delete(threadId);
    if (threads?.size === 0) enabledThreads.delete(environmentId);
  }
  for (const listener of listeners) listener();
}

/** Subscribes to a thread's reader preference across navigation. */
export function useVoiceReaderEnabled(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return useSyncExternalStore(
    subscribeVoiceReaderEnabled,
    () => getVoiceReaderEnabled(environmentId, threadId),
    () => false,
  );
}
