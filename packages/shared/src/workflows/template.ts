import * as Result from "effect/Result";
import { evalExpr, parseExpr } from "./expr.ts";
import type {
  EvalEnv,
  EvalError,
  ExprError,
  JsonValue,
  ParsedTemplate,
  TemplatePart,
} from "./types.ts";

/** Parses holes while respecting quoted delimiters. */
export const parseTemplate = (text: string): Result.Result<ParsedTemplate, ExprError> => {
  const parts: TemplatePart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{{", cursor);
    if (start < 0) {
      parts.push({ type: "text", text: text.slice(cursor) });
      break;
    }
    if (start > cursor) parts.push({ type: "text", text: text.slice(cursor, start) });
    let end = start + 2;
    let quote = "";
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) {
        if (c === "\\") end++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (text.startsWith("}}", end)) break;
    }
    if (end >= text.length) return Result.fail({ message: "unclosed hole", offset: start });
    const inner = text.slice(start + 2, end);
    const source = inner.trim();
    const parsed = parseExpr(source);
    if (Result.isFailure(parsed))
      return Result.fail({
        ...parsed.failure,
        offset: start + 2 + inner.length - inner.trimStart().length + parsed.failure.offset,
      });
    parts.push({ type: "expr", expr: parsed.success, source });
    cursor = end + 2;
  }
  return Result.succeed({ parts });
};
/** Converts JSON values to prompt text. */
const renderValue = (value: JsonValue): string =>
  value === null
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
/** Renders all holes, propagating evaluation failures. */
export const renderTemplate = (
  template: ParsedTemplate,
  env: EvalEnv,
): Result.Result<string, EvalError> => {
  let text = "";
  for (const part of template.parts) {
    if (part.type === "text") text += part.text;
    else {
      const result = evalExpr(part.expr, env);
      if (Result.isFailure(result)) return Result.fail(result.failure);
      text += renderValue(result.success);
    }
  }
  return Result.succeed(text);
};
/** Preserves the JSON value of a single hole surrounded by whitespace. */
export const evalTemplateValue = (
  template: ParsedTemplate,
  env: EvalEnv,
): Result.Result<JsonValue, EvalError> => {
  const parts = template.parts.filter((p) => p.type === "expr" || p.text.trim() !== "");
  const part = parts[0];
  return parts.length === 1 && part?.type === "expr"
    ? evalExpr(part.expr, env)
    : renderTemplate(template, env);
};

/** Evaluates trigger params, omitting failures so the run uses the param default. */
export const triggerParams = (
  templates: Readonly<Record<string, string>> | undefined,
  trigger: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> => {
  const params: Record<string, JsonValue> = {};
  for (const [name, template] of Object.entries(templates ?? {})) {
    const parsed = parseTemplate(template);
    if (Result.isFailure(parsed)) continue;
    const value = evalTemplateValue(parsed.success, { roots: { trigger } });
    if (Result.isSuccess(value)) params[name] = value.success;
  }
  return params;
};
