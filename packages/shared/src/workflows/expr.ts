/**
 * The one expression language of workflows (`when`, `until`, `check`, `keep`, `target`, `items`, `{{ }}`),
 * parsed to an AST and evaluated over JSON, never `eval`ed. Grammar: docs/friend/workflows-design.md
 * §1.3, plus unary minus (`neg := '-' neg | atom`, below `*`/`/`) and `[n]` index segments in paths.
 */
import { WORKFLOW_LEDGER_ID_PATTERN } from "@t3tools/contracts";
import * as Result from "effect/Result";
import {
  EXPR_FUNCTIONS,
  type BinaryOp,
  type EvalEnv,
  type EvalError,
  type Expr,
  type ExprError,
  type JsonValue,
  type PathExpr,
} from "./types.ts";

/** Parses one expression, rejecting trailing input. */
export const parseExpr = (text: string): Result.Result<Expr, ExprError> => {
  let pos = 0;
  const fail = (message: string, offset = pos): never => {
    throw { message, offset };
  };
  const space = () => {
    while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++;
  };
  const take = (s: string) => {
    space();
    if (text.startsWith(s, pos)) {
      pos += s.length;
      return true;
    }
    return false;
  };
  const need = (s: string) => {
    if (!take(s)) fail(`expected ${s}`);
  };
  const atom = (): Expr => {
    space();
    if (take("(")) {
      const e = binary(0);
      need(")");
      return e;
    }
    const start = pos;
    const quote = text[pos];
    if (quote === '"' || quote === "'") {
      pos++;
      let value = "";
      while (pos < text.length) {
        const c = text[pos++];
        if (c === quote) return { type: "literal", value };
        if (c === "\\") {
          const escaped = text[pos++];
          const escapes: Record<string, string> = {
            n: "\n",
            t: "\t",
            "\\": "\\",
            "'": "'",
            '"': '"',
          };
          if (escaped === undefined || !Object.hasOwn(escapes, escaped)) fail("invalid escape");
          value += escapes[escaped ?? ""];
        } else value += c;
      }
      return fail("unterminated string", start);
    }
    const number = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (number) {
      pos += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) fail("non-finite number");
      return { type: "literal", value };
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos));
    if (!id) return fail("unexpected character");
    pos += id[0].length;
    const name = id[0];
    if (name === "true" || name === "false" || name === "null")
      return { type: "literal", value: name === "null" ? null : name === "true" };
    if (take("(")) {
      const fn = EXPR_FUNCTIONS.find((f) => f === name);
      if (!fn) return fail("unknown function", start);
      const args: Expr[] = [];
      space();
      const argumentStart = pos;
      if (!take(")")) {
        do {
          args.push(binary(0));
        } while (take(","));
        need(")");
      }
      const count =
        fn === "len" || fn === "any" || fn === "all" || fn === "ledgerDigest" || fn === "ledgerBest"
          ? 1
          : fn === "contains" || fn === "startsWith"
            ? 2
            : null;
      const least = fn === "table" ? 2 : 1;
      if (count === null ? args.length < least : args.length !== count) fail("wrong arity", start);
      if (fn === "ledgerDigest" || fn === "ledgerBest") {
        const a = args[0];
        if (
          a?.type !== "literal" ||
          typeof a.value !== "string" ||
          !WORKFLOW_LEDGER_ID_PATTERN.test(a.value)
        )
          fail("invalid ledger id literal", argumentStart);
      }
      return { type: "call", fn, args };
    }
    const segments: (string | number)[] = [];
    while (true) {
      if (take(".")) {
        space();
        const part = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos));
        if (!part) return fail("expected identifier");
        pos += part[0].length;
        segments.push(part[0]);
      } else if (take("[")) {
        space();
        const index = /^\d+/.exec(text.slice(pos));
        if (!index) return fail("expected integer");
        pos += index[0].length;
        segments.push(Number(index[0]));
        need("]");
      } else break;
    }
    return { type: "path", root: name, segments };
  };
  const levels: BinaryOp[][] = [
    ["||"],
    ["&&"],
    [],
    ["<=", ">=", "==", "!=", "<", ">"],
    ["+", "-"],
    ["*", "/"],
  ];
  const binary = (level: number): Expr => {
    if (level === 6) return take("-") ? { type: "unary", op: "-", arg: binary(6) } : atom();
    if (level === 2) return take("!") ? { type: "unary", op: "!", arg: binary(2) } : binary(3);
    let left = binary(level + 1);
    let compared = false;
    while (true) {
      const op = levels[level]?.find((o) => {
        space();
        return text.startsWith(o, pos);
      });
      if (!op) break;
      if (level === 3 && compared) fail("chained comparison");
      pos += op.length;
      left = { type: "binary", op, left, right: binary(level + 1) };
      compared = true;
    }
    return left;
  };
  try {
    const expr = binary(0);
    space();
    if (pos !== text.length) fail("trailing input");
    return Result.succeed(expr);
  } catch (error) {
    return Result.fail({
      message:
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : String(error),
      offset:
        typeof error === "object" &&
        error !== null &&
        "offset" in error &&
        typeof error.offset === "number"
          ? error.offset
          : pos,
    });
  }
};

/** Collects paths in source order. */
export const exprPaths = (expr: Expr): ReadonlyArray<PathExpr> => {
  switch (expr.type) {
    case "path":
      return [expr];
    case "literal":
      return [];
    case "unary":
      return exprPaths(expr.arg);
    case "binary":
      return [...exprPaths(expr.left), ...exprPaths(expr.right)];
    case "call":
      return expr.args.flatMap(exprPaths);
  }
};
/** Implements workflow truthiness, including truthy empty collections. */
export const isTruthy = (value: JsonValue): boolean => Boolean(value);
const equal = (a: JsonValue, b: JsonValue): boolean => {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const entries = Object.entries(a);
  return (
    entries.length === Object.keys(b).length &&
    entries.every(
      ([k, v]) => Object.hasOwn(b, k) && equal(v, (b as Record<string, JsonValue>)[k] ?? null),
    )
  );
};
/** Evaluates JSON expressions without executing source code. */
export const evalExpr = (expr: Expr, env: EvalEnv): Result.Result<JsonValue, EvalError> => {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const numeric = (v: JsonValue): number =>
    typeof v === "number" ? v : fail(`expected number, got ${typeof v}`);
  const run = (e: Expr): JsonValue => {
    const value = evaluate(e);
    if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite result");
    return value;
  };
  const evaluate = (e: Expr): JsonValue => {
    if (e.type === "literal") return e.value;
    if (e.type === "path") {
      let v = Object.hasOwn(env.roots, e.root) ? (env.roots[e.root] ?? null) : null;
      for (const s of e.segments) {
        if (typeof s === "number") v = Array.isArray(v) ? (v[s] ?? null) : null;
        else
          v =
            v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, s)
              ? ((v as Record<string, JsonValue>)[s] ?? null)
              : null;
      }
      return v;
    }
    if (e.type === "unary") return e.op === "!" ? !isTruthy(run(e.arg)) : -numeric(run(e.arg));
    if (e.type === "binary") {
      const a = run(e.left);
      if (e.op === "&&") return isTruthy(a) && isTruthy(run(e.right));
      if (e.op === "||") return isTruthy(a) || isTruthy(run(e.right));
      const b = run(e.right);
      switch (e.op) {
        case "==":
          return equal(a, b);
        case "!=":
          return !equal(a, b);
        case "<":
        case "<=":
        case ">":
        case ">=": {
          if (
            !(typeof a === "number" && typeof b === "number") &&
            !(typeof a === "string" && typeof b === "string")
          )
            return fail(`cannot compare ${typeof a} and ${typeof b}`);
          return e.op === "<" ? a < b : e.op === "<=" ? a <= b : e.op === ">" ? a > b : a >= b;
        }
        case "+":
          if (typeof a === "string" && typeof b === "string") return a + b;
          return numeric(a) + numeric(b);
        case "-":
          return numeric(a) - numeric(b);
        case "*":
          return numeric(a) * numeric(b);
        case "/":
          if (numeric(b) === 0) return fail("division by zero");
          return numeric(a) / numeric(b);
      }
    }
    if (e.fn === "coalesce") {
      for (const arg of e.args) {
        const v = run(arg);
        if (v !== null) return v;
      }
      return null;
    }
    const args = e.args.map(run);
    const a = args[0] ?? null;
    const b = args[1] ?? null;
    switch (e.fn) {
      case "ledgerDigest":
      case "ledgerBest": {
        const fn = env[e.fn];
        if (!fn) return fail("ledger not available");
        return typeof a === "string" ? fn(a) : fail("expected ledger id");
      }
      case "len":
        return typeof a === "string" || Array.isArray(a)
          ? a.length
          : a !== null && typeof a === "object"
            ? Object.keys(a).length
            : fail("len expects collection");
      case "any":
      case "all":
        if (!Array.isArray(a)) return fail("expected array");
        return e.fn === "any" ? a.some(isTruthy) : a.every(isTruthy);
      case "contains":
        if (Array.isArray(a)) return a.some((v) => equal(v, b));
        if (typeof a === "string" && typeof b === "string") return a.includes(b);
        return fail("invalid contains arguments");
      case "startsWith":
        return typeof a === "string" && typeof b === "string"
          ? a.startsWith(b)
          : fail("expected strings");
      case "table": {
        if (!Array.isArray(a)) return fail("table expects a list of rows");
        const columns = args.slice(1);
        if (!columns.every((c): c is string => typeof c === "string"))
          return fail("table columns are strings");
        const cell = (value: JsonValue | undefined): string =>
          (value === undefined || value === null
            ? ""
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value)
          )
            .replace(/\|/g, "\\|")
            .replace(/\s*\n\s*/g, " ");
        const line = (cells: ReadonlyArray<string>) => `| ${cells.join(" | ")} |`;
        return [
          line(columns),
          line(columns.map(() => "---")),
          ...a.map((row) =>
            line(
              columns.map((c) =>
                row !== null && typeof row === "object" && !Array.isArray(row) ? cell(row[c]) : "",
              ),
            ),
          ),
        ].join("\n");
      }
      case "min":
      case "max": {
        const values = args.length === 1 && Array.isArray(a) ? a : args;
        if (!values.length) return fail("empty numbers");
        return e.fn === "min" ? Math.min(...values.map(numeric)) : Math.max(...values.map(numeric));
      }
    }
  };
  try {
    const value = run(expr);
    if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite result");
    return Result.succeed(value);
  } catch (error) {
    return Result.fail({ message: error instanceof Error ? error.message : String(error) });
  }
};
