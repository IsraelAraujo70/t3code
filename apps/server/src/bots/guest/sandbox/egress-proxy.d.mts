import type { LookupAddress } from "node:dns";
import type { Server } from "node:http";
/** Classify an IP literal for public egress. */
export function isPublicAddress(ip: string): boolean;
/** Create an unbound CONNECT proxy with injectable address policy. */
export function createEgressProxy(options?: {
  lookup?: (host: string) => Promise<LookupAddress[]>;
  isAllowedAddress?: (ip: string) => boolean;
  log?: (line: string) => void;
}): Server;
