import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import { parseTemplate, evalTemplateValue } from "./template.ts";
describe("templates", () => {
  it.each([
    ["{{ x }}", { a: 1 }],
    ["hello {{ x }}", 'hello {"a":1}'],
    ['{{ "}}" }}', "}}"],
  ] as const)("renders %s", (text, value) => {
    const parsed = parseTemplate(text);
    if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
    expect(evalTemplateValue(parsed.success, { roots: { x: { a: 1 } } })).toEqual(
      Result.succeed(value),
    );
  });
  it("reports the opening offset", () =>
    expect(parseTemplate("hi {{ x")).toEqual(Result.fail({ message: "unclosed hole", offset: 3 })));
});

it.each([
  ["a {{ 2 }} b {{ true }} c {{ null }}", "a 2 b true c "],
  ["}} outside", "}} outside"],
  ["text {{ 2 }}", "text 2"],
] as const)("renders mixed template %s", (source, value) => {
  const parsed = parseTemplate(source);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  expect(evalTemplateValue(parsed.success, { roots: {} })).toEqual(Result.succeed(value));
});
it.each([
  ["{{ }}", 3],
  ["hi {{  @ }}", 7],
] as const)("reports hole offset for %s", (source, offset) => {
  const parsed = parseTemplate(source);
  expect(Result.isFailure(parsed)).toBe(true);
  if (Result.isFailure(parsed)) expect(parsed.failure.offset).toBe(offset);
});
