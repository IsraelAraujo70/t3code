import type * as NodeHttp from "node:http";

/** Creates the standalone echo API without listening on a port. */
export function createFakeAnthropic(options?: {
  chunkDelayMs?: number;
  /** When set, requests without exactly this `x-api-key` get 401. */
  expectKey?: string;
}): NodeHttp.Server;
