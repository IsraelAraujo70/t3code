import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";

import { WorkflowHash, type WorkflowDefinition } from "@t3tools/contracts";

/** JSON with object keys sorted at every level and `undefined` members dropped. */
const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  // fromEntries defines own properties, so a `__proto__` key stays in the hash.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, sortKeys(member)]),
  );
};

/** sha256 of the canonical JSON without `canvas`: moving a box does not change the version that runs. */
export const semanticHash = (definition: WorkflowDefinition): WorkflowHash => {
  const { canvas: _canvas, ...semantic } = definition;
  return WorkflowHash.make(
    `sha256:${Hex.encode(sha256(new TextEncoder().encode(canonicalJson(semantic))))}`,
  );
};
