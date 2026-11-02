/**
 * YAML ⇄ workflow definition. The canonical text is the decoded definition stringified: decoding
 * puts every object's keys in schema field order and keeps the author's order of nodes, so the
 * same definition always prints the same bytes. Comments do not survive; free text goes in `description`.
 */
import * as Result from "effect/Result";
import { parse, stringify, YAMLParseError } from "yaml";

import type { WorkflowDefinition, WorkflowDiagnostic } from "@t3tools/contracts";

/** Parses YAML 1.2 (no merge keys, unique keys); a syntax error becomes a `schema` diagnostic. */
export const parseWorkflowSource = (source: string): Result.Result<unknown, WorkflowDiagnostic> => {
  try {
    return Result.succeed(parse(source, { uniqueKeys: true, merge: false, maxAliasCount: 0 }));
  } catch (error) {
    const position = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;
    const where = position === undefined ? "" : ` at line ${position.line}, column ${position.col}`;
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return Result.fail({ path: "", code: "schema", message: `Invalid YAML${where}: ${reason}` });
  }
};

/** The canonical YAML of a decoded definition. */
export const toCanonicalYaml = (definition: WorkflowDefinition): string =>
  stringify(definition, { indent: 2, lineWidth: 100, aliasDuplicateObjects: false });
