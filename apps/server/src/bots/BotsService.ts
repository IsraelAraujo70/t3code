/**
 * Rows commit before thread launches; deterministic thread and command ids let startup repair missing threads.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  BOT_LIMITS,
  BotId,
  BotMemoryId,
  BotSectionId,
  BotsError,
  botThreadId,
  CommandId,
  enabledMemoryCharacters,
  parseBotThreadId,
  type Bot,
  type BotCreateInput,
  type BotDirectory,
  type BotLinkedEnvironmentsInput,
  type BotMemory,
  type BotMemoryCreateInput,
  type BotMemoryRef,
  type BotMemorySource,
  type BotMemoryUpdateInput,
  type BotPushDeviceRef,
  type BotPushDeviceRegisterInput,
  type BotRef,
  type BotSection,
  type BotSectionCreateInput,
  type BotSectionRef,
  type BotSectionRenameInput,
  type BotsArrangeInput,
  type BotsOwnerUpdateInput,
  type BotUpdateInput,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { BotsStore } from "./BotsStore.ts";

export class BotsService extends Context.Service<
  BotsService,
  {
    /** The current directory on subscribe, then a fresh one after every committed change. */
    readonly directory: Stream.Stream<BotDirectory, BotsError>;
    readonly createBot: (input: BotCreateInput) => Effect.Effect<Bot, BotsError>;
    readonly updateBot: (input: BotUpdateInput) => Effect.Effect<Bot, BotsError>;
    readonly deleteBot: (input: BotRef) => Effect.Effect<BotRef, BotsError>;
    readonly resetConversation: (input: BotRef) => Effect.Effect<Bot, BotsError>;
    /**
     * Duplicate text for the same bot fails with BotsError, and so does a bot's own save that
     * would take its enabled memories past BOT_LIMITS.memoryBudget.
     */
    readonly createMemory: (
      input: BotMemoryCreateInput,
      source: BotMemorySource,
    ) => Effect.Effect<BotMemory, BotsError>;
    readonly updateMemory: (input: BotMemoryUpdateInput) => Effect.Effect<BotMemory, BotsError>;
    readonly deleteMemory: (input: BotMemoryRef) => Effect.Effect<BotMemoryRef, BotsError>;
    readonly memoriesOf: (botId: BotId) => Effect.Effect<ReadonlyArray<BotMemory>, BotsError>;
    readonly updateOwner: (
      input: BotsOwnerUpdateInput,
    ) => Effect.Effect<BotsOwnerUpdateInput, BotsError>;
    readonly createSection: (input: BotSectionCreateInput) => Effect.Effect<BotSection, BotsError>;
    readonly renameSection: (input: BotSectionRenameInput) => Effect.Effect<BotSection, BotsError>;
    /** Its bots go back to the default list. */
    readonly deleteSection: (input: BotSectionRef) => Effect.Effect<BotSectionRef, BotsError>;
    /** Reorders sections and bots and moves bots between sections, all at once. */
    readonly arrange: (input: BotsArrangeInput) => Effect.Effect<BotsArrangeInput, BotsError>;
    /**
     * Launches the bot's current main thread if it is missing. Idempotent; for bots written to
     * `bots.sqlite` while the server runs (the guest CLI), which startup reconciliation would
     * otherwise only launch at the next start.
     */
    readonly ensureConversation: (input: BotRef) => Effect.Effect<Bot, BotsError>;
    /**
     * The user's switch for one bot's linked environments, from their session only: no MCP tool
     * calls it. Turning it on for a guest's bot fails.
     */
    readonly setBotLinkedEnvironments: (
      input: BotLinkedEnvironmentsInput,
    ) => Effect.Effect<BotLinkedEnvironmentsInput, BotsError>;
    /** The bot a thread belongs to, from its id; none for every other thread. */
    readonly botForThread: (threadId: ThreadId) => Effect.Effect<Option.Option<Bot>, BotsError>;
    /** Idempotent: the app repeats it on every connect and token rotation. */
    readonly registerPushDevice: (
      input: BotPushDeviceRegisterInput,
    ) => Effect.Effect<BotPushDeviceRef, BotsError>;
    /** Unregistering an unknown token succeeds. */
    readonly unregisterPushDevice: (
      input: BotPushDeviceRef,
    ) => Effect.Effect<BotPushDeviceRef, BotsError>;
  }
>()("t3/bots/BotsService") {}

const SCRATCH_UNAVAILABLE_MESSAGE =
  'Bots need the "No project" folder, which this environment does not offer because its T3 data directory is inside a Git checkout.';

const randomHex = randomUuidV4.pipe(Effect.map((uuid) => uuid.replaceAll("-", "")));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const botsError = (message: string) => (cause: unknown) => new BotsError({ message, cause });

const threadTitle = (bot: Pick<Bot, "name">) => bot.name;

const nextPosition = (rows: ReadonlyArray<{ readonly position: number }>) =>
  rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;

/** The ids of `expected` and `given` are the same set, each listed once. */
const sameIds = (expected: ReadonlyArray<string>, given: ReadonlyArray<string>) =>
  expected.length === given.length &&
  new Set(given).size === given.length &&
  given.every((id) => expected.includes(id));

const make = Effect.gen(function* () {
  const store = yield* BotsStore;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const managed = yield* ManagedProjectFolders.ManagedProjectFolders;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  // Sliding(1): every signal re-reads the whole directory, so only the latest one matters.
  const changes = yield* PubSub.sliding<void>(1);
  const publish = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const requireBot = (botId: BotId) =>
    store.getBot(botId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new BotsError({ message: `Bot ${botId} does not exist.` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const requireMemory = (memoryId: BotMemoryId) =>
    store.getMemory(memoryId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new BotsError({ message: `Memory ${memoryId} does not exist.` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  // Bots also pick models through MCP; a disabled or unknown instance would only fail on the bot's
  // first turn.
  const requireEnabledInstance = (model: ModelSelection) =>
    providers
      .getInstance(model.instanceId)
      .pipe(
        Effect.flatMap((instance) =>
          instance?.enabled === true
            ? Effect.void
            : Effect.fail(
                new BotsError({ message: `No enabled provider instance ${model.instanceId}.` }),
              ),
        ),
      );

  /** Idempotent: the command id is fixed per bot generation, so retries replay the receipt. */
  const launchMainThread = Effect.fn("BotsService.launchMainThread")(function* (bot: Bot) {
    const { projectId } = yield* managed.ensureScratchProject.pipe(
      Effect.mapError((error) =>
        error._tag === "ScratchUnavailableError"
          ? new BotsError({ message: SCRATCH_UNAVAILABLE_MESSAGE })
          : new BotsError({ message: error.message, cause: error }),
      ),
    );
    yield* launches
      .launch({
        commandId: CommandId.make(`bots:launch:${bot.id}:${bot.homeGeneration}`),
        threadId: botThreadId(bot.id, bot.homeGeneration),
        projectId,
        title: threadTitle(bot),
        generateTitle: false,
        modelSelection: bot.model,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError(botsError(`Could not start the conversation of ${threadTitle(bot)}.`)));
  });

  /** An archived, deleted or missing thread is left as it is. */
  const archiveThread = Effect.fn("BotsService.archiveThread")(
    function* (botId: BotId, generation: number) {
      const threadId = botThreadId(botId, generation);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) return;
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`bots:archive:${botId}:${generation}`),
        threadId,
      });
    },
    (effect, botId) =>
      effect.pipe(
        Effect.mapError(botsError(`Could not archive the conversation of bot ${botId}.`)),
      ),
  );

  /** A thread already carrying the title is left alone, so retries and restarts are no-ops. */
  const retitleThread = Effect.fn("BotsService.retitleThread")(
    function* (bot: Bot) {
      const threadId = botThreadId(bot.id, bot.homeGeneration);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null || shell.title === threadTitle(bot)) return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(
          `bots:retitle:${bot.id}:${bot.homeGeneration}:${yield* randomHex}`,
        ),
        threadId,
        title: threadTitle(bot),
      });
    },
    (effect, bot) =>
      effect.pipe(
        Effect.mapError(botsError(`Could not rename the conversation of ${threadTitle(bot)}.`)),
      ),
  );

  const readDirectory: Effect.Effect<BotDirectory, BotsError> = Effect.gen(function* () {
    const sections = yield* store.listSections;
    const bots = yield* store.listBots;
    const memories = yield* store.listMemories();
    const aboutMe = yield* store.getAboutMe;
    const linkedEnvironmentBotIds = yield* store.listLinkedEnvironmentBots;
    const guestBotIds = yield* store.listGuestBotIds;
    const memoriesByBot = new Map<BotId, Array<BotMemory>>();
    for (const memory of memories) {
      const list = memoriesByBot.get(memory.botId);
      if (list === undefined) memoriesByBot.set(memory.botId, [memory]);
      else list.push(memory);
    }
    return {
      sections,
      bots: bots.map((bot) => ({
        ...bot,
        homeThreadId: botThreadId(bot.id, bot.homeGeneration),
        memories: memoriesByBot.get(bot.id) ?? [],
      })),
      aboutMe,
      linkedEnvironmentBotIds,
      guestBotIds,
    };
  });

  const directory = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the first read so a change landing in between is not lost.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(readDirectory),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => readDirectory)),
      );
    }),
  );

  const assertNewMemoryText = (botId: BotId, text: string, except?: BotMemoryId) =>
    store
      .listMemories(botId)
      .pipe(
        Effect.flatMap((memories) =>
          memories.some((memory) => memory.text === text && memory.id !== except)
            ? Effect.fail(new BotsError({ message: "This bot already remembers that." }))
            : Effect.void,
        ),
      );

  const createBot = Effect.fn("BotsService.createBot")(function* (input: BotCreateInput) {
    yield* requireEnabledInstance(input.model);
    const bots = yield* store.listBots;
    const now = yield* nowIso;
    const bot: Bot = {
      id: BotId.make(`b_${yield* randomHex}`),
      name: input.name,
      role: input.role,
      model: input.model,
      homeGeneration: 1,
      sectionId: null,
      position: nextPosition(bots),
      canManageBots: input.canManageBots ?? false,
      createdAt: now,
      updatedAt: now,
    };
    yield* store.insertBot(bot);
    yield* publish;
    yield* launchMainThread(bot);
    return bot;
  });

  const updateBot = Effect.fn("BotsService.updateBot")(function* (input: BotUpdateInput) {
    const current = yield* requireBot(input.botId);
    if (input.model !== undefined) yield* requireEnabledInstance(input.model);
    const bot: Bot = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      // The live thread keeps its model; the next conversation generation starts with this one.
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.canManageBots !== undefined ? { canManageBots: input.canManageBots } : {}),
      updatedAt: yield* nowIso,
    };
    yield* store.updateBot(bot);
    yield* publish;
    if (bot.name !== current.name) yield* retitleThread(bot);
    return bot;
  });

  const deleteBot = Effect.fn("BotsService.deleteBot")(function* (input: BotRef) {
    const bot = yield* store.getBot(input.botId);
    if (Option.isSome(bot)) yield* archiveThread(bot.value.id, bot.value.homeGeneration);
    yield* store.deleteBot(input.botId);
    yield* publish;
    return input;
  });

  const resetConversation = Effect.fn("BotsService.resetConversation")(function* (input: BotRef) {
    const current = yield* requireBot(input.botId);
    const bot: Bot = {
      ...current,
      homeGeneration: current.homeGeneration + 1,
      updatedAt: yield* nowIso,
    };
    yield* store.updateBot(bot);
    yield* publish;
    yield* archiveThread(current.id, current.homeGeneration);
    yield* launchMainThread(bot);
    return bot;
  });

  // A full memory makes the bot merge or forget instead of growing every prompt; the bot reads
  // this message as memory_save's error, so it says how.
  const assertWithinBudget = (botId: BotId, text: string) =>
    store.listMemories(botId).pipe(
      Effect.flatMap((memories) => {
        const used = enabledMemoryCharacters(memories);
        return used + text.length <= BOT_LIMITS.memoryBudget
          ? Effect.void
          : Effect.fail(
              new BotsError({
                message: `Your memory is full: enabled memories use ${used} of ${BOT_LIMITS.memoryBudget} characters, and this one needs ${text.length}. Merge related memories into one shorter memory and forget stale ones with memory_forget, then save again.`,
              }),
            );
      }),
    );

  const createMemory = Effect.fn("BotsService.createMemory")(function* (
    input: BotMemoryCreateInput,
    source: BotMemorySource,
  ) {
    yield* requireBot(input.botId);
    yield* assertNewMemoryText(input.botId, input.text);
    if (source === "bot") yield* assertWithinBudget(input.botId, input.text);
    const now = yield* nowIso;
    const memory: BotMemory = {
      id: BotMemoryId.make(`mem_${yield* randomHex}`),
      botId: input.botId,
      text: input.text,
      source,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    yield* store.insertMemory(memory);
    yield* publish;
    return memory;
  });

  const updateMemory = Effect.fn("BotsService.updateMemory")(function* (
    input: BotMemoryUpdateInput,
  ) {
    const current = yield* requireMemory(input.memoryId);
    if (input.text !== undefined && input.text !== current.text) {
      yield* assertNewMemoryText(current.botId, input.text, current.id);
    }
    const memory: BotMemory = {
      ...current,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: yield* nowIso,
    };
    yield* store.updateMemory(memory);
    yield* publish;
    return memory;
  });

  const deleteMemory = (input: BotMemoryRef) =>
    store.deleteMemory(input.memoryId).pipe(Effect.andThen(publish), Effect.as(input));

  const updateOwner = (input: BotsOwnerUpdateInput) =>
    store.setAboutMe(input.aboutMe).pipe(Effect.andThen(publish), Effect.as(input));

  const requireSection = (sectionId: BotSectionId) =>
    store.getSection(sectionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new BotsError({ message: `Section ${sectionId} does not exist.` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const createSection = Effect.fn("BotsService.createSection")(function* (
    input: BotSectionCreateInput,
  ) {
    const sections = yield* store.listSections;
    const now = yield* nowIso;
    const section: BotSection = {
      id: BotSectionId.make(`s_${yield* randomHex}`),
      name: input.name,
      position: nextPosition(sections),
      createdAt: now,
      updatedAt: now,
    };
    yield* store.insertSection(section);
    yield* publish;
    return section;
  });

  const renameSection = Effect.fn("BotsService.renameSection")(function* (
    input: BotSectionRenameInput,
  ) {
    const current = yield* requireSection(input.sectionId);
    const section: BotSection = { ...current, name: input.name, updatedAt: yield* nowIso };
    yield* store.updateSection(section);
    yield* publish;
    return section;
  });

  const deleteSection = (input: BotSectionRef) =>
    store.deleteSection(input.sectionId).pipe(Effect.andThen(publish), Effect.as(input));

  const arrange = Effect.fn("BotsService.arrange")(function* (input: BotsArrangeInput) {
    const sections = yield* store.listSections;
    const bots = yield* store.listBots;
    const sectionIds = sections.map((section) => section.id);
    if (
      !sameIds(sectionIds, input.sectionIds) ||
      !sameIds(
        bots.map((bot) => bot.id),
        input.bots.map((bot) => bot.botId),
      ) ||
      input.bots.some((bot) => bot.sectionId !== null && !sectionIds.includes(bot.sectionId))
    ) {
      return yield* new BotsError({
        message: "The bots changed while you were arranging them. Try again.",
      });
    }
    yield* store.arrange(input);
    yield* publish;
    return input;
  });

  const ensureConversation = Effect.fn("BotsService.ensureConversation")(function* (input: BotRef) {
    const bot = yield* requireBot(input.botId);
    yield* launchMainThread(bot);
    return bot;
  });

  const botForThread = (threadId: ThreadId) => {
    const parsed = parseBotThreadId(threadId);
    return parsed === null ? Effect.succeed(Option.none<Bot>()) : store.getBot(parsed.botId);
  };

  const registerPushDevice = Effect.fn("BotsService.registerPushDevice")(function* (
    input: BotPushDeviceRegisterInput,
  ) {
    const now = yield* nowIso;
    yield* store.upsertPushDevice({
      token: input.token,
      label: input.label ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { token: input.token };
  });

  const unregisterPushDevice = (input: BotPushDeviceRef) =>
    store.deletePushDevice(input.token).pipe(Effect.as(input));

  // Heals a crash between a bot's row write and its launch. Runs beside startup, not before it.
  yield* store.listBots.pipe(
    Effect.flatMap((bots) =>
      Effect.forEach(
        bots,
        (bot) =>
          launchMainThread(bot).pipe(
            Effect.andThen(retitleThread(bot)),
            Effect.catch((error) =>
              Effect.logWarning("Could not reconcile a bot's conversation", {
                botId: bot.id,
                error,
              }),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.catch((error) => Effect.logWarning("Could not list bots to reconcile", { error })),
    Effect.forkScoped,
  );

  const setBotLinkedEnvironments = Effect.fn("BotsService.setBotLinkedEnvironments")(function* (
    input: BotLinkedEnvironmentsInput,
  ) {
    const bot = yield* requireBot(input.botId);
    if (input.linkedEnvironments && (yield* store.listGuestBotIds).includes(bot.id)) {
      return yield* new BotsError({
        message: `${bot.name} belongs to a guest, so it cannot use linked environments.`,
      });
    }
    yield* store.setBotLinkedEnvironments(bot.id, input.linkedEnvironments);
    yield* publish;
    return input;
  });

  return BotsService.of({
    directory,
    createBot,
    updateBot,
    deleteBot,
    resetConversation,
    createMemory,
    updateMemory,
    deleteMemory,
    memoriesOf: Effect.fn("BotsService.memoriesOf")((botId) => store.listMemories(botId)),
    updateOwner,
    createSection,
    renameSection,
    deleteSection,
    arrange,
    ensureConversation,
    setBotLinkedEnvironments,
    botForThread,
    registerPushDevice,
    unregisterPushDevice,
  });
});

/**
 * Needs the orchestration runtime (ThreadLaunchService, ManagedProjectFolders,
 * ThreadManagementService, provider instances), which server.ts provides beneath it.
 */
export const layer = Layer.effect(BotsService, make);
