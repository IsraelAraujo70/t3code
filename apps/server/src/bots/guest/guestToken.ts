/**
 * Guest tokens: 32 random bytes, base64url, behind a `t3g_` prefix so a leaked one is easy to
 * recognize. The server keeps only the sha256 hex digest.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- sync hashing on the request path and in the CLI.
import * as NodeCrypto from "node:crypto";

export const GUEST_TOKEN_PREFIX = "t3g_";

const TOKEN_PATTERN = /^t3g_[A-Za-z0-9_-]{43}$/;

export function generateGuestToken(): string {
  return `${GUEST_TOKEN_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
}

/** sha256 hex of the token, or null when it is not shaped like one (never worth a lookup). */
export function hashGuestToken(token: string): string | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  return NodeCrypto.createHash("sha256").update(token).digest("hex");
}
