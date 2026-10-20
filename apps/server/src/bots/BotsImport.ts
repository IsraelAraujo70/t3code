/**
 * Reads the friend app's database and plans an import into bots. Reading is read-only and never
 * touches friend's `mcp_servers` column: it holds credentials, and extra MCP servers are not
 * imported. Planning is pure; BotsService commits the batch and launches the threads.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  BOT_LIMITS,
  BotId,
  BotMemoryId,
  BotsError,
  type Bot,
  type BotMemory,
  type BotMemorySource,
  type BotsImportBotPlan,
  type BotsImportResult,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

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

const FriendBotRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    emoji: Schema.String,
    role: Schema.String,
    model: Schema.String,
    effort: Schema.NullOr(Schema.String),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
);

const FriendMemoryRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    botId: Schema.String,
    text: Schema.String,
    source: Schema.String,
    enabled: Schema.Number,
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
);

const FriendSettingRows = Schema.Array(Schema.Struct({ value: Schema.String }));

/**
 * Opens `path` read-only and closes it before returning. Fails with BotsError naming the path
 * when the file or its tables are missing. Columns are listed explicitly so `mcp_servers` is
 * never read.
 */
export const readFriendDatabase = (path: string): Effect.Effect<FriendSnapshot, BotsError> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const bots = yield* sql`
          SELECT id, name, emoji, role, model, effort,
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM bots
          ORDER BY seq
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(FriendBotRows)));
        const memories = yield* sql`
          SELECT id, bot_id AS "botId", text, source, enabled,
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM memories
          ORDER BY seq
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(FriendMemoryRows)));
        const settings = yield* sql`
          SELECT value FROM settings WHERE key = 'aboutMe'
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(FriendSettingRows)));
        return {
          bots,
          memories: memories.map((memory) => ({ ...memory, enabled: memory.enabled !== 0 })),
          aboutMe: settings[0]?.value ?? "",
        } satisfies FriendSnapshot;
      }),
    );
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: path, readonly: true })),
    // Schema errors carry the rejected row, so only SQL causes are kept.
    Effect.mapError((cause) =>
      cause._tag === "SqlError"
        ? new BotsError({ message: `Could not read friend's database at ${path}`, cause })
        : new BotsError({ message: `Friend's database at ${path} has unexpected rows` }),
    ),
  );

const isBotId = Schema.is(BotId);
const isBotMemoryId = Schema.is(BotMemoryId);

/** Trimmed text when it is non-blank and within `max`, otherwise null. */
function boundedText(value: string, max: number): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function memorySource(source: string): BotMemorySource {
  return source === "user" || source === "bot" ? source : "import";
}

function modelSelection(
  model: string,
  effort: string | null,
  instances: ReadonlyArray<ImportProviderInstance>,
): ModelSelection | null {
  const claude = model.startsWith("claude-");
  const instance = instances.find(
    (candidate) => candidate.enabled && candidate.driver === (claude ? "claudeAgent" : "codex"),
  );
  if (instance === undefined) return null;
  const level = effort?.trim() ?? "";
  if (level.length === 0) return { instanceId: instance.instanceId, model };
  return {
    instanceId: instance.instanceId,
    model,
    options: [{ id: claude ? "effort" : "reasoningEffort", value: level }],
  };
}

/**
 * Pure. `result.applied` is false; BotsService sets it after committing `batch`. Bots and
 * memories keep friend's ids; invalid rows (bad id, over-long text) are skipped with a warning.
 * Bots that already exist here or have no matching provider instance stay out of the batch,
 * with their memories.
 */
export function planFriendImport(input: FriendImportPlanInput): {
  readonly result: BotsImportResult;
  readonly batch: BotsImportBatch;
} {
  const { snapshot, now } = input;
  const warnings: Array<string> = [];

  const memoriesByBot = new Map<BotId, Array<BotMemory>>();
  const validBotIds = new Set<BotId>();
  const validMemories: Array<BotMemory> = [];
  // Bot validity decides memory validity, so bots are checked first.
  const bots: Array<{
    readonly bot: Bot | null;
    readonly plan: Omit<BotsImportBotPlan, "memories">;
  }> = [];
  snapshot.bots.forEach((row, index) => {
    const name = boundedText(row.name, BOT_LIMITS.name);
    const emoji = boundedText(row.emoji, BOT_LIMITS.emoji);
    if (!isBotId(row.id)) {
      warnings.push(`Skipped a bot with an invalid id (${JSON.stringify(row.id.slice(0, 80))}).`);
      return;
    }
    if (name === null || emoji === null || row.role.length > BOT_LIMITS.role) {
      warnings.push(`Skipped bot ${row.id}: its name, emoji, or role is empty or too long.`);
      return;
    }
    validBotIds.add(row.id);
    const status = input.existingBotIds.has(row.id) ? "exists" : "new";
    const model = modelSelection(row.model, row.effort, input.instances);
    if (model === null) {
      warnings.push(
        `Bot ${name} (${row.id}) uses ${row.model}, which no enabled provider instance serves; it is not imported.`,
      );
    }
    const bot: Bot | null =
      model === null || status === "exists"
        ? null
        : {
            id: row.id,
            name,
            emoji,
            role: row.role,
            model,
            homeGeneration: 1,
            position: index,
            createdAt: row.createdAt || now,
            updatedAt: row.updatedAt || now,
          };
    bots.push({ bot, plan: { sourceId: row.id, name, emoji, status, model } });
  });

  const seenTexts = new Set<string>();
  for (const row of snapshot.memories) {
    if (!isBotMemoryId(row.id)) {
      warnings.push(
        `Skipped a memory with an invalid id (${JSON.stringify(row.id.slice(0, 80))}).`,
      );
      continue;
    }
    if (!isBotId(row.botId) || !validBotIds.has(row.botId)) {
      warnings.push(`Skipped memory ${row.id}: its bot was not imported.`);
      continue;
    }
    const text = boundedText(row.text, BOT_LIMITS.memory);
    if (text === null) {
      warnings.push(`Skipped memory ${row.id}: its text is empty or too long.`);
      continue;
    }
    // The store rejects a second memory with the same text on one bot, which would fail the batch.
    const textKey = `${row.botId}\u0000${text}`;
    if (seenTexts.has(textKey)) {
      warnings.push(`Skipped memory ${row.id}: its bot already has a memory with the same text.`);
      continue;
    }
    seenTexts.add(textKey);
    const memory: BotMemory = {
      id: row.id,
      botId: row.botId,
      text,
      source: memorySource(row.source),
      enabled: row.enabled,
      createdAt: row.createdAt || now,
      updatedAt: row.updatedAt || now,
    };
    validMemories.push(memory);
    const list = memoriesByBot.get(row.botId);
    if (list === undefined) memoriesByBot.set(row.botId, [memory]);
    else list.push(memory);
  }

  const batchBots = bots.flatMap(({ bot }) => (bot === null ? [] : [bot]));
  const batchBotIds = new Set(batchBots.map((bot) => bot.id));

  const friendAboutMe = snapshot.aboutMe.trim();
  const localAboutMe = input.existingAboutMe.trim();
  let aboutMe: BotsImportResult["aboutMe"];
  if (friendAboutMe.length === 0) aboutMe = "none";
  else if (friendAboutMe === localAboutMe) aboutMe = "same";
  else if (localAboutMe.length > 0) aboutMe = "keep-local";
  else if (snapshot.aboutMe.length > BOT_LIMITS.aboutMe) {
    warnings.push(
      `Friend's "about me" is longer than ${BOT_LIMITS.aboutMe} characters; it is not imported.`,
    );
    aboutMe = "keep-local";
  } else aboutMe = "replace";

  return {
    result: {
      path: input.path,
      applied: false,
      bots: bots.map(({ plan }) => ({
        ...plan,
        memories: memoriesByBot.get(plan.sourceId)?.length ?? 0,
      })),
      aboutMe,
      warnings,
    },
    batch: {
      bots: batchBots,
      memories: validMemories.filter((memory) => batchBotIds.has(memory.botId)),
      aboutMe: aboutMe === "replace" ? snapshot.aboutMe : null,
    },
  };
}
