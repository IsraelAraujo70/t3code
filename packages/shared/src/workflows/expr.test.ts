import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import { evalExpr, parseExpr, isTruthy, exprPaths } from "./expr.ts";
describe("expressions", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["-2 * -3", 6],
    ["false && (1/0 == 1)", false],
    ["coalesce(1,1/0)", 1],
    ["missing.x", null],
    ["all(x)", true],
  ] as const)("evaluates %s", (source, value) => {
    const parsed = parseExpr(source);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed))
      expect(evalExpr(parsed.success, { roots: { x: [] } })).toEqual(Result.succeed(value));
  });
  it.each([
    "a < b < c",
    "unknown()",
    "len()",
    "ledgerBest(x)",
    "ledgerBest('BAD')",
    "1 2",
    "'oops",
    "@",
  ])("rejects %s", (source) => expect(Result.isFailure(parseExpr(source))).toBe(true));
});

it.each([
  ["unknown()", 0],
  [" len()", 1],
  ["ledgerBest( 'BAD')", 12],
  ["1 2", 2],
  [" 'oops", 1],
  [" @", 1],
  ["a < b < c", 6],
] as const)("reports token offset for %s", (source, offset) => {
  const result = parseExpr(source);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure.offset).toBe(offset);
});

it("contains deep parser failures", () => {
  const result = parseExpr("(".repeat(3000) + "1" + ")".repeat(3000));
  if (Result.isFailure(result)) {
    expect(typeof result.failure.message).toBe("string");
    expect(typeof result.failure.offset).toBe("number");
  }
});

it.each([
  ["n.x", null],
  ["s.x", null],
  ["o[0]", null],
  ["a.x", null],
  ["a[99]", null],
  ["!0", true],
  ["1 && 2", true],
  ["0 && 1/0", false],
  ["1 || 1/0", true],
  ["0 || 2", true],
  ["a == a", true],
  ["a != empty", true],
  ["o == o", true],
  ["o != other", true],
  ["1 < 2", true],
  ["2 >= 2", true],
  ["'a' < 'b'", true],
  ["'b' <= 'b'", true],
  ["2 > 1", true],
  ["1 + 2", 3],
  ["'a' + 'b'", "ab"],
  ["4 - 2", 2],
  ["3 * 2", 6],
  ["6 / 2", 3],
  ["len(s)", 3],
  ["len(a)", 1],
  ["len(o)", 1],
  ["any(a)", true],
  ["all(a)", true],
  ["any(empty)", false],
  ["all(empty)", true],
  ["contains(s, 'b')", true],
  ["contains(a, o)", true],
  ["startsWith(s, 'a')", true],
  ["min(3, 1)", 1],
  ["max(3, 1)", 3],
  ["min(nums)", 1],
  ["max(nums)", 3],
  ["coalesce(n, 2)", 2],
  ["coalesce(1, 1/0)", 1],
  [
    "table(rows, 'ticket', 'pr', 'reason')",
    "| ticket | pr | reason |\n| --- | --- | --- |\n| BACK-1 | https://pr/1 |  |\n| BACK-2 |  | a \\| b c |",
  ],
] as const)("evaluates rule %s", (source, value) => {
  const parsed = parseExpr(source);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  expect(
    evalExpr(parsed.success, {
      roots: {
        n: null,
        s: "abc",
        o: { k: 1 },
        other: { k: 2 },
        a: [{ k: 1 }],
        empty: [],
        nums: [3, 1],
        rows: [
          { ticket: "BACK-1", pr: "https://pr/1", reason: null },
          { ticket: "BACK-2", reason: "a | b\n  c" },
        ],
      },
    }),
  ).toEqual(Result.succeed(value));
});

it.each([
  ["-'a'", "expected number, got string"],
  ["1 < 'a'", "cannot compare number and string"],
  ["1 + 'a'", "expected number, got string"],
  ["1/0", "division by zero"],
  ["1e308 * 2", "non-finite result"],
  ["len(1)", "len expects collection"],
  ["any(1)", "expected array"],
  ["all(1)", "expected array"],
  ["contains(1, 2)", "invalid contains arguments"],
  ["startsWith(1, 2)", "expected strings"],
  ["min(empty)", "empty numbers"],
  ["max(empty)", "empty numbers"],
  ["min('a')", "expected number, got string"],
  ["max('a')", "expected number, got string"],
  ["ledgerBest('valid')", "ledger not available"],
  ["ledgerDigest('valid')", "ledger not available"],
  ["table(1, 'a')", "table expects a list of rows"],
  ["table(empty, 1)", "table columns are strings"],
] as const)("reports evaluation error for %s", (source, message) => {
  const parsed = parseExpr(source);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  expect(evalExpr(parsed.success, { roots: { empty: [] } })).toEqual(Result.fail({ message }));
});

it.each([false, null, 0, NaN, ""])("treats %s as falsy", (value) =>
  expect(isTruthy(value)).toBe(false),
);
it.each([[], {}])("treats collections as truthy", (value) => expect(isTruthy(value)).toBe(true));
it("collects paths in source order", () => {
  const parsed = parseExpr("coalesce(a.x, -b[0]) + c");
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  expect(exprPaths(parsed.success)).toEqual([
    { type: "path", root: "a", segments: ["x"] },
    { type: "path", root: "b", segments: [0] },
    { type: "path", root: "c", segments: [] },
  ]);
});
it.each(["ledgerBest", "ledgerDigest"] as const)("calls %s from the environment", (fn) => {
  const parsed = parseExpr(fn + "('valid')");
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  expect(evalExpr(parsed.success, { roots: {}, [fn]: (id: string) => id + "-result" })).toEqual(
    Result.succeed("valid-result"),
  );
});
