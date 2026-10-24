import type * as NodeHttp from "node:http";

export const BOT_API_PREFIX: string;
export function isBotApiPath(rawPath: string): boolean;
/** An unbound server forwarding the Bot API to Lurian with the guest's token. */
export function createLurianForwarder(options: {
  upstream?: string;
  readToken: () => string | null;
  log?: (line: string) => void;
}): NodeHttp.Server;
