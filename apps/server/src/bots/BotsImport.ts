/**
 * Reads the friend app's database and plans an import into bots. Reading is read-only and never
 * touches friend's `mcp_servers` column: it holds credentials, and extra MCP servers are not
 * imported. Planning is pure; BotsService commits the batch and launches the threads.
 */
import * as Effect from "effect/Effect";

import type { BotId, BotsError, BotsImportResult, ProviderInstanceId } from "@t3tools/contracts";

import type { BotsImportBatch } from "./BotsStore.ts";

/** Friend's database relative to the server user's home directory. */
export const FRIEND_DB_RELATIVE_PATH = ".local/share/friend/friend.db";

/** What the import reads from friend, already parsed. */
export interface FriendSnapshot {
  readonly bots: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly emoji: string;
    readonly role: string;
    /** Friend's model id, e.g. `claude-opus-5-5` or `gpt-6.1-sol`. */
    readonly model: string;
    readonly effort: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
  readonly memories: ReadonlyArray<{
    readonly id: string;
    readonly botId: string;
    readonly text: string;
    readonly source: string;
    readonly enabled: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
  /** Friend's global "Sobre mim" (settings key `aboutMe`); empty when unset. */
  readonly aboutMe: string;
}

export interface ImportProviderInstance {
  readonly instanceId: ProviderInstanceId;
  /** Provider driver kind, e.g. `claudeAgent` or `codex`. */
  readonly driver: string;
  readonly enabled: boolean;
}

export interface FriendImportPlanInput {
  readonly snapshot: FriendSnapshot;
  readonly path: string;
  readonly existingBotIds: ReadonlySet<BotId>;
  readonly existingAboutMe: string;
  /** Enabled instances in preference order; `claude-*` models go to the first claudeAgent one, others to codex. */
  readonly instances: ReadonlyArray<ImportProviderInstance>;
  readonly now: string;
}

/** Opens `path` read-only. Fails with BotsError when the file or its tables are missing. */
export const readFriendDatabase = (_path: string): Effect.Effect<FriendSnapshot, BotsError> =>
  Effect.die("not implemented: readFriendDatabase");

/**
 * Pure. `result.applied` is false; BotsService sets it after committing `batch`. Bots and
 * memories keep friend's ids; invalid rows (bad id, over-long text) are skipped with a warning.
 */
export function planFriendImport(_input: FriendImportPlanInput): {
  readonly result: BotsImportResult;
  readonly batch: BotsImportBatch;
} {
  throw new Error("not implemented: planFriendImport");
}
