import type * as NodeHttp from "node:http";

/**
 * Creates the standalone echo API without listening on a port. A user line `fake-tools: [{"name",
 * "input"}…]` makes the reply call those tools, and tool results are quoted back.
 */
export function createFakeAnthropic(options?: {
  chunkDelayMs?: number;
  /** When set, requests without exactly this `x-api-key` get 401. */
  expectKey?: string;
  /** When set, requests need `Authorization: Bearer` with it, the OAuth beta, and no API key. */
  expectBearer?: string;
}): NodeHttp.Server;
