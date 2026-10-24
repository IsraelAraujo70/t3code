import type * as NodeHttp from "node:http";

export const ROUTES: ReadonlyArray<{ prefix: string; host: string; upstreamPrefix: string }>;
export const GOOGLE_TOKEN_URL: string;
export const NOT_CONFIGURED: string;
export function googleTarget(rawTarget: string): string | null;
export type GoogleCredential = {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
};
/** An unbound server forwarding the guest's Google API calls with a refreshed access token. */
export function createGoogleForwarder(options: {
  readCredential: () => GoogleCredential | null;
  tokenUrl?: string;
  resolve?: (url: string) => string;
  log?: (line: string) => void;
}): NodeHttp.Server;
