import { describe, expect, it } from "vite-plus/test";
import { webhookPayload } from "./webhookPayload.ts";

const request = {
  method: "POST",
  path: "/hook",
  query: "token=secret&name=ok",
  headers: { authorization: "secret" },
  bodyText: "",
};

describe("webhookPayload", () => {
  it.each([
    ['{"x":1}', {}, { x: 1 }],
    [
      "x=hello+world",
      { "content-type": "application/x-www-form-urlencoded" },
      { x: "hello world" },
    ],
    ["hello", {}, "hello"],
    ["", {}, null],
  ])("parses body %s and redacts credentials", (bodyText, headers, body) => {
    expect(
      webhookPayload(
        { ...request, bodyText, headers: { ...request.headers, ...headers } },
        "framed",
      ),
    ).toEqual({
      method: "POST",
      path: "/hook",
      query: { token: "[redacted]", name: "ok" },
      headers: { authorization: "[redacted]", ...headers },
      body,
      text: "framed",
    });
  });
  it("drops oversized bodies", () => {
    const bodyText = "a".repeat(256 * 1024);
    expect(webhookPayload({ ...request, bodyText }, "framed")).toMatchObject({
      body: null,
      bodyBytes: bodyText.length,
      bodyTruncated: true,
      text: "framed",
    });
  });
});
