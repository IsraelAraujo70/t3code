import type * as NodeHttp from "node:http";

export function isAllowedModel(model: unknown, allowedModels: ReadonlyArray<string>): boolean;
export function capEffort<T>(body: T, maxEffort: string | undefined): T;
export const OAUTH_BETA: string;
export function withBeta(header: string | ReadonlyArray<string> | undefined, beta: string): string;
export type ForwardCredential = { readonly kind: "oauth" | "apiKey"; readonly value: string };
/** An unbound server forwarding the guest's Anthropic calls with the real key. */
export function createApiForwarder(options: {
  upstream?: string;
  readCredential: () => ForwardCredential | null;
  allowedModels: ReadonlyArray<string>;
  maxEffort?: string;
  log?: (line: string) => void;
}): NodeHttp.Server;
