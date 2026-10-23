import { formatGuestPairing } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatPairing, parsePairing } from "./pairing";

describe("parsePairing", () => {
  it("reads what the server's QR code encodes", () => {
    const text = formatGuestPairing({ server: "http://100.67.31.112:3794", token: "a+b/c=d&e" });
    expect(parsePairing(text)).toEqual({ server: "http://100.67.31.112:3794", token: "a+b/c=d&e" });
  });

  it("keeps only the server origin", () => {
    const text = "t3guest://pair?server=https%3A%2F%2FExample.com%3A8443%2Fsome%2Fpath&token=t";
    expect(parsePairing(text)).toEqual({ server: "https://example.com:8443", token: "t" });
  });

  it("ignores surrounding whitespace from a paste", () => {
    const text = `  \n${formatGuestPairing({ server: "http://10.0.2.2:3794", token: "tok" })}\n `;
    expect(parsePairing(text)).toEqual({ server: "http://10.0.2.2:3794", token: "tok" });
  });

  it("rejects another scheme or host", () => {
    expect(parsePairing("t3code://pair?server=http%3A%2F%2Fh&token=t")).toBeNull();
    expect(parsePairing("https://pair?server=http%3A%2F%2Fh&token=t")).toBeNull();
    expect(parsePairing("t3guest://login?server=http%3A%2F%2Fh&token=t")).toBeNull();
    expect(parsePairing("hello")).toBeNull();
  });

  it("rejects a server that is not http(s)", () => {
    expect(parsePairing("t3guest://pair?server=ftp%3A%2F%2Fh&token=t")).toBeNull();
    expect(parsePairing("t3guest://pair?server=javascript%3Aalert(1)&token=t")).toBeNull();
    expect(parsePairing("t3guest://pair?server=not-a-url&token=t")).toBeNull();
  });

  it("rejects a missing or empty token", () => {
    expect(parsePairing("t3guest://pair?server=http%3A%2F%2Fh")).toBeNull();
    expect(parsePairing("t3guest://pair?server=http%3A%2F%2Fh&token=")).toBeNull();
  });

  it("round-trips its own format", () => {
    const pairing = { server: "http://100.67.31.112:3794", token: "x y%z" };
    expect(parsePairing(formatPairing(pairing))).toEqual(pairing);
    expect(parsePairing(formatGuestPairing(pairing))).toEqual(pairing);
  });
});
