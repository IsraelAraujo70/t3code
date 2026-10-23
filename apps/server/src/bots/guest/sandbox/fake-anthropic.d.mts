import type * as NodeHttp from "node:http";

/** Creates the standalone echo API without listening on a port. */
export function createFakeAnthropic(options?: { chunkDelayMs?: number }): NodeHttp.Server;
