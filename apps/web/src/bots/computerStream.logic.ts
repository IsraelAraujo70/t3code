import { ComputerStreamServerMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 10_000;

/** Wait before reconnect attempt `failures + 1`: doubles from half a second, capped at ten. */
export const computerStreamRetryDelayMs = (failures: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures), RETRY_MAX_MS);

const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ComputerStreamServerMessage),
);

/** A text frame from the Computer stream, or null when it is not one the contract defines. */
export const parseComputerStreamMessage = (text: string): ComputerStreamServerMessage | null =>
  Option.getOrNull(decodeServerMessage(text));
