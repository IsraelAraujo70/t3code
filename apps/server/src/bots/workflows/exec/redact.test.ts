import { expect, it } from "vite-plus/test";

import { redactSecrets } from "./redact.ts";

it("masks URL credentials and well-known tokens a failing command printed", () => {
  const stderr = [
    "fatal: unable to access 'https://x-access-token:ghs_AbCdEfGhIjKlMnOpQrSt@github.com/o/r.git/'",
    "fatal: could not read from https://ghp_AbCdEfGhIjKlMnOpQrStUv@github.com/o/r",
    "token github_pat_11ABCDEFG0123456789_abcdefghij expired",
    "OPENAI said: invalid key sk-proj-abcdefghijklmnop1234",
    "slack: xoxb-1234567890-abcdefghij rejected",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "Cannot tell whether main contains v0.1.6",
  ].join("\n");
  expect(redactSecrets(stderr)).toBe(
    [
      "fatal: unable to access 'https://***@github.com/o/r.git/'",
      "fatal: could not read from https://***@github.com/o/r",
      "token github_pat_*** expired",
      "OPENAI said: invalid key sk-***",
      "slack: xoxb-*** rejected",
      "Authorization: Bearer ***",
      "Cannot tell whether main contains v0.1.6",
    ].join("\n"),
  );
});
