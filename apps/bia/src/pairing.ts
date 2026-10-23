import type { GUEST_PAIRING_SCHEME } from "@t3tools/contracts";

export interface Pairing {
  readonly server: string;
  readonly token: string;
}

const PAIRING_SCHEME = "t3guest:" satisfies typeof GUEST_PAIRING_SCHEME;

const PAIRING_PREFIX = new RegExp(`^${PAIRING_SCHEME}//pair\\?`, "i");
const HTTP_ORIGIN = /^(https?):\/\/([^/?#\s@]+)(?:[/?#]|$)/i;

function decodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * Reads `t3guest://pair?server=<origin>&token=<token>` (the owner's QR code) into a server origin
 * and token, or null for anything else. Hand-rolled because React Native's `URL` has no reliable
 * `searchParams`; it mirrors the contract's `parseGuestPairing`.
 */
export function parsePairing(text: string): Pairing | null {
  const trimmed = text.trim();
  const prefix = PAIRING_PREFIX.exec(trimmed);
  if (prefix === null) return null;

  const params = new Map<string, string>();
  for (const part of trimmed.slice(prefix[0].length).split("#")[0]!.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = decodeParam(part.slice(0, separator));
    const value = decodeParam(part.slice(separator + 1));
    if (key === null || value === null) return null;
    if (!params.has(key)) params.set(key, value);
  }

  const token = params.get("token");
  const server = params.get("server");
  if (token === undefined || token.length === 0 || server === undefined) return null;

  const origin = HTTP_ORIGIN.exec(server.trim());
  if (origin === null) return null;
  return { server: `${origin[1]!.toLowerCase()}://${origin[2]!.toLowerCase()}`, token };
}

/** The QR text for a pairing; `parsePairing(formatPairing(p))` gives `p` back. */
export function formatPairing(pairing: Pairing): string {
  const server = encodeURIComponent(pairing.server);
  return `${PAIRING_SCHEME}//pair?server=${server}&token=${encodeURIComponent(pairing.token)}`;
}
