import type * as NodeHttp from "node:http";

export function isAllowedModel(model: unknown, allowedModels: ReadonlyArray<string>): boolean;
export function capEffort<T>(body: T, maxEffort: string | undefined): T;
/** An unbound server forwarding the guest's Anthropic calls with the real key. */
export function createApiForwarder(options: {
  upstream?: string;
  readKey: () => string | null;
  allowedModels: ReadonlyArray<string>;
  maxEffort?: string;
  log?: (line: string) => void;
}): NodeHttp.Server;
