import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { checkOutput } from "./output.ts";

const shape = {
  tag: { type: "string", pattern: "^v[0-9]+$" },
  files: { type: "string[]", pattern: "^[a-z/.]+$" },
  count: { type: "number" },
  note: { type: "string", optional: true },
} as const;

describe("checkOutput", () => {
  it("matches a pattern against the whole value", () => {
    expect(
      checkOutput(
        { ref: { type: "string", pattern: "[a-z0-9-]+" } },
        { ref: "x --upload-pack=evil" },
      ),
    ).toEqual(Result.fail("ref does not match [a-z0-9-]+"));
  });

  it("keeps only declared fields of a valid output", () => {
    expect(
      checkOutput(shape, { tag: "v2", files: ["a/b.ts"], count: 3, extra: "--rm -rf" }),
    ).toEqual(Result.succeed({ tag: "v2", files: ["a/b.ts"], count: 3 }));
  });

  it.each([
    [{ tag: "--unexpected-option", files: [], count: 1 }, "tag does not match ^v[0-9]+$"],
    [
      { tag: "v1", files: ["ok", "--force"], count: 1 },
      "every item of files must match ^[a-z/.]+$",
    ],
    [{ tag: "v1", files: [], count: "1" }, "count must be a number"],
    [{ tag: "v1", count: 1 }, "files is missing"],
    [["v1"], "the output must be a JSON object"],
  ] as const)("refuses %j", (output, error) => {
    expect(checkOutput(shape, output)).toEqual(Result.fail(error));
  });
});
