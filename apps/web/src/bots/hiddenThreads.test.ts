import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sidebarListedThreads } from "./hiddenThreads";

const botsEnvironmentId = EnvironmentId.make("env-bots");
const thread = (id: string) => ({ environmentId: botsEnvironmentId, id: ThreadId.make(id) });
const hidden = thread("bot:b_1:t-0000aaaa");
const shown = thread("bot:b_1:t-0000bbbb");
const plain = thread("thread-a");
const threads = [hidden, shown, plain];
const options = { botsEnvironmentId, hiddenThreadIds: [hidden.id], searching: false } as const;

describe("sidebarListedThreads", () => {
  it("leaves hidden side threads out of every layout's list", () => {
    expect(sidebarListedThreads(threads, { ...options, layout: "mixed" })).toEqual([shown, plain]);
    expect(sidebarListedThreads(threads, { ...options, layout: "rail" })).toEqual([shown, plain]);
    expect(sidebarListedThreads(threads, { ...options, layout: "sections" })).toEqual([plain]);
  });

  it("lets a search find hidden side threads in every layout", () => {
    for (const layout of ["mixed", "rail", "sections", "tabs"] as const) {
      expect(sidebarListedThreads(threads, { ...options, layout, searching: true })).toBe(threads);
    }
  });
});
