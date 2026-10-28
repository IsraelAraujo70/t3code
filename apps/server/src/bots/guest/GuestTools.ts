/**
 * The tools a guest's bot gets besides Claude Code's own: generate or edit an image with the
 * owner's ChatGPT plan (CodexImages), publish an HTML page, and list the conversation's images.
 * They run in the T3 server process; the sandboxed Claude Code reaches them as an in-process MCP
 * server over its own stdin/stdout (ClaudeAdapterV2 attaches AppTools only to guest sandboxes), so
 * no network path or credential enters the sandbox.
 *
 * What the bot can do with them, and nothing more:
 * - Each tool is bound to the thread the host resolved for the turn; no argument names a thread,
 *   a bot or a path. Images to edit are named by attachment id and must be images of that same
 *   conversation (a person's upload or an image a tool generated there).
 * - An HTML page is stored as given (plus T3's theme bootstrap) and never runs on the host: no
 *   host browser renders or measures it, and no local file is inlined. The guest's app shows it
 *   under the same sandbox CSP T3 uses.
 * - Image generation sends only the prompt and the chosen images to Codex, at most
 *   T3CODE_GUEST_IMAGES_PER_DAY per guest per 24 hours.
 */
import {
  BotsError,
  ChatAttachmentId,
  parseBotThreadId,
  type BotId,
  type GuestId,
  type OrchestrationV2ConversationMessage,
  type ThreadId,
} from "@t3tools/contracts";
import type { AppTool, AppTools } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  clampHtmlRenderHeight,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  injectHtmlRenderBootstrap,
} from "@t3tools/shared/htmlRender";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { attachmentRelativePath, createAttachmentId } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { CodexImages, type SourceImage } from "./CodexImages.ts";
import { type GuestArtifact, GuestArtifacts } from "./GuestArtifacts.ts";
import { GUEST_MESSAGE_ID_PREFIX, isGuestVisible } from "./guestSender.ts";
import { GuestStore } from "./GuestStore.ts";
import { HostMcpForward } from "./HostMcpForward.ts";

/** The MCP server name: Claude Code shows the tools as `mcp__t3-guest__<tool>`. */
export const GUEST_TOOLS_SERVER = "t3-guest";
export const GUEST_IMAGES_PER_DAY_ENV = "T3CODE_GUEST_IMAGES_PER_DAY";
const DEFAULT_IMAGES_PER_DAY = 30;

const MAX_HTML_CHARS = 512_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_EDIT_IMAGES = 4;
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const LISTED_IMAGES = 20;

export interface ConversationImage {
  readonly id: string;
  readonly from: "guest" | "owner" | "bot";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

/**
 * Pure. Every image of a conversation a guest can see, oldest first: images people sent and
 * images the bot's tools generated.
 */
export function conversationImages(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  artifacts: ReadonlyArray<GuestArtifact>,
): ReadonlyArray<ConversationImage> {
  const fromMessages = messages.filter(isGuestVisible).flatMap((message) =>
    message.attachments.flatMap((attachment): ConversationImage[] =>
      attachment.type === "image"
        ? [
            {
              id: attachment.id,
              from:
                message.role === "assistant"
                  ? "bot"
                  : message.id.startsWith(GUEST_MESSAGE_ID_PREFIX)
                    ? "guest"
                    : "owner",
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    ),
  );
  const generated = artifacts.flatMap((artifact): ConversationImage[] =>
    artifact.kind === "image"
      ? [
          {
            id: artifact.id,
            from: "bot",
            name: artifact.name,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            createdAt: artifact.createdAt,
          },
        ]
      : [],
  );
  return [...fromMessages, ...generated].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

/** Pure. Where an image's bytes live under the attachments directory; null for unsafe ids. */
export const imageRelativePath = (
  image: Pick<ConversationImage, "id" | "name" | "mimeType" | "sizeBytes">,
) =>
  attachmentRelativePath({
    type: "image",
    id: ChatAttachmentId.make(image.id),
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
  });

const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

const GenerateArgs = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PROMPT_CHARS)),
  edit_image_ids: Schema.optional(
    Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_EDIT_IMAGES)),
  ),
});
const HtmlArgs = Schema.Struct({
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_HTML_CHARS)),
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
  ),
  height: Schema.Number,
});
const ListArgs = Schema.Struct({});

/** A failure the bot reads as the tool's result. */
class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String,
}) {}

const toolFailure = (message: string) => new ToolFailure({ message });

const decodeArgs =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (args: unknown) =>
    Schema.decodeEffect(schema)(args ?? {}, { onExcessProperty: "error" }).pipe(
      Effect.mapError((issue) => toolFailure(`Invalid arguments: ${issue.message}`)),
    );

export class GuestTools extends Context.Service<
  GuestTools,
  {
    /**
     * The tools of a guest-owned bot's thread, its own `t3-guest` server first, then the host MCP
     * servers configured for that bot; undefined for every other thread.
     */
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AppTools> | undefined, BotsError>;
  }
>()("t3/bots/guest/GuestTools") {}

const make = Effect.gen(function* () {
  const services = yield* Effect.context<never>();
  const guests = yield* GuestStore;
  const artifacts = yield* GuestArtifacts;
  const images = yield* CodexImages;
  const hostMcp = yield* HostMcpForward;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const imagesPerDay = yield* Config.Int(GUEST_IMAGES_PER_DAY_ENV).pipe(
    Config.withDefault(DEFAULT_IMAGES_PER_DAY),
    Effect.orElseSucceed(() => DEFAULT_IMAGES_PER_DAY),
  );

  const threadImages = Effect.fn("GuestTools.threadImages")(
    function* (threadId: ThreadId) {
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user", "assistant"],
      });
      const generated = yield* artifacts.listForThread(threadId);
      return conversationImages(messages, generated);
    },
    Effect.mapError(() => toolFailure("Could not read this conversation.")),
  );

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const writeAttachment = (relativePath: string, data: Uint8Array | string) =>
    (typeof data === "string"
      ? fs.writeFileString(path.join(config.attachmentsDir, relativePath), data)
      : fs.writeFile(path.join(config.attachmentsDir, relativePath), data)
    ).pipe(Effect.mapError(() => toolFailure("Could not save the result.")));

  const record = (artifact: GuestArtifact) =>
    artifacts
      .record(artifact)
      .pipe(Effect.mapError(() => toolFailure("Could not save the result.")));

  const listImages = Effect.fn("GuestTools.listImages")(function* (threadId: ThreadId) {
    const all = yield* threadImages(threadId);
    if (all.length === 0) return "This conversation has no images yet.";
    const shown = all.slice(-LISTED_IMAGES);
    return [
      `Images in this conversation, oldest first (id · sent by · name · time)${all.length > shown.length ? `; the latest ${shown.length} of ${all.length}` : ""}:`,
      ...shown.map((image) => `${image.id} · ${image.from} · ${image.name} · ${image.createdAt}`),
    ].join("\n");
  });

  const generate = Effect.fn("GuestTools.generateImage")(function* (
    target: { readonly threadId: ThreadId; readonly botId: BotId; readonly guestId: GuestId },
    args: typeof GenerateArgs.Type,
  ) {
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }));
    const used = yield* artifacts
      .countImagesSince(target.guestId, since)
      .pipe(Effect.mapError(() => toolFailure("Could not check the image allowance.")));
    if (used >= imagesPerDay) {
      return yield* toolFailure(
        `The daily image allowance (${imagesPerDay} per 24 hours) is used up. Tell the guest to try again tomorrow.`,
      );
    }
    const sources: SourceImage[] = [];
    if ((args.edit_image_ids ?? []).length > 0) {
      const known = yield* threadImages(target.threadId);
      for (const id of args.edit_image_ids ?? []) {
        const image = known.find((candidate) => candidate.id === id);
        const relative = image === undefined ? null : imageRelativePath(image);
        if (image === undefined || relative === null) {
          return yield* toolFailure(
            `No image ${id} in this conversation. Call list_images for the ids.`,
          );
        }
        if (image.sizeBytes > MAX_SOURCE_IMAGE_BYTES) {
          return yield* toolFailure(`Image ${id} is too large to edit.`);
        }
        const bytes = yield* fs
          .readFile(path.join(config.attachmentsDir, relative))
          .pipe(Effect.mapError(() => toolFailure(`Image ${id} could not be read.`)));
        sources.push({ mimeType: image.mimeType, bytes });
      }
    }
    const result = yield* images
      .generate({ prompt: args.prompt, images: sources })
      .pipe(Effect.mapError((error) => toolFailure(error.message)));
    const id = createAttachmentId(target.threadId);
    if (id === null) return yield* toolFailure("Could not save the image.");
    const name = `imagem.${IMAGE_EXTENSIONS[result.mimeType]}`;
    const artifact: GuestArtifact = {
      id,
      botId: target.botId,
      threadId: target.threadId,
      kind: "image",
      name,
      mimeType: result.mimeType,
      height: null,
      sizeBytes: result.bytes.byteLength,
      createdAt: yield* now,
    };
    const relative = imageRelativePath(artifact);
    if (relative === null) return yield* toolFailure("Could not save the image.");
    yield* writeAttachment(relative, result.bytes);
    yield* record(artifact);
    return [
      `Done: image ${id} is now in the chat, above your reply, where the guest sees it full size and can save or share it.`,
      "Don't describe it at length; say what you made or ask if they want changes. To change it, call generate_image again with this id in edit_image_ids.",
      ...(result.revisedPrompt === null
        ? []
        : [`Prompt the image model used: ${result.revisedPrompt}`]),
    ].join(" ");
  });

  const renderHtml = Effect.fn("GuestTools.renderHtml")(function* (
    target: { readonly threadId: ThreadId; readonly botId: BotId },
    args: typeof HtmlArgs.Type,
  ) {
    const id = createAttachmentId(target.threadId, "html");
    if (id === null) return yield* toolFailure("Could not save the page.");
    const html = injectHtmlRenderBootstrap(args.html);
    yield* writeAttachment(`${id}.html`, html);
    yield* record({
      id,
      botId: target.botId,
      threadId: target.threadId,
      kind: "html",
      name: args.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "Página",
      mimeType: "text/html",
      height: clampHtmlRenderHeight(args.height),
      sizeBytes: Buffer.byteLength(html),
      createdAt: yield* now,
    });
    return "Shown to the guest above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";
  });

  /** Runs a tool to a result the bot reads; nothing it does can throw past this. */
  const runTool =
    <A>(
      name: string,
      decode: (args: unknown) => Effect.Effect<A, ToolFailure>,
      handler: (args: A) => Effect.Effect<string, ToolFailure>,
    ) =>
    (args: unknown) =>
      Effect.runPromiseWith(services)(
        decode(args).pipe(
          Effect.flatMap(handler),
          Effect.map((text) => ({ text })),
          Effect.catchTags({
            ToolFailure: (failure) => Effect.succeed({ text: failure.message, isError: true }),
          }),
          Effect.catchDefect((defect) =>
            Effect.logError(`Guest tool ${name} failed`, { defect }).pipe(
              Effect.as({ text: "The tool failed on the server. Try again later.", isError: true }),
            ),
          ),
        ),
      );

  const forThread = Effect.fn("GuestTools.forThread")(function* (threadId: ThreadId) {
    const parsed = parseBotThreadId(threadId);
    if (parsed === null) return undefined;
    const guestId = yield* guests.guestOfBot(parsed.botId);
    if (Option.isNone(guestId)) return undefined;
    const target = { threadId, botId: parsed.botId, guestId: guestId.value };
    const tools: ReadonlyArray<AppTool> = [
      {
        name: "generate_image",
        description: [
          "Generate a new image, or edit images from this conversation, and show it in the chat above your reply.",
          "Use it whenever the guest asks for a picture, drawing, illustration, sticker, logo, edit of a photo and so on.",
          "It takes about a minute. Write the prompt in detail (subject, style, composition, text to show).",
          "To edit or reuse images (a photo the guest sent, an image you made before), pass their ids in edit_image_ids; list_images gives the ids.",
          `At most ${imagesPerDay} images per guest per day.`,
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "What to make, or what to change in the given images.",
            },
            edit_image_ids: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_EDIT_IMAGES,
              description: "Ids of images from this conversation to edit or use as reference.",
            },
          },
          required: ["prompt"],
        },
        run: runTool("generate_image", decodeArgs(GenerateArgs), (args) => generate(target, args)),
      },
      {
        name: "list_images",
        description:
          "List the images in this conversation (photos people sent and images you generated) with their ids, for generate_image's edit_image_ids.",
        inputSchema: { type: "object", properties: {} },
        run: runTool("list_images", decodeArgs(ListArgs), () => listImages(threadId)),
      },
      {
        name: "html_render",
        description: [
          "Show a finished HTML page (chart, table, comparison, schedule, small app, styled card) inline in the chat, above your final text reply; call it before writing that reply.",
          "The guest reads it on a phone about 360px wide, so design for that width: fluid width, no horizontal scrolling, readable font sizes.",
          "Write one self-contained document with inline <style> and <script>. Images must be https URLs or data: URLs; local file paths do not work.",
          "Remote https resources such as a chart library from a CDN load as-is.",
          "Do not use vh, svh, lvh or dvh units, or height:100% on html or body: the frame grows to fit the page.",
          "By default leave html and body without a background, so the page sits on the chat's own background.",
          HTML_RENDER_THEME_GUIDE.replaceAll("T3", "The app"),
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            html: { type: "string", description: "A complete, self-contained HTML document." },
            title: { type: "string", description: "Short name for the page." },
            height: {
              type: "integer",
              description: `Expected page height in CSS pixels at a 360px width, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. The app fits the frame to the page it loads.`,
            },
          },
          required: ["html", "title", "height"],
        },
        run: runTool("html_render", decodeArgs(HtmlArgs), (args) => renderHtml(target, args)),
      },
    ];
    // Forwarding never costs the bot its own tools.
    const forwarded = yield* hostMcp
      .forBot(parsed.botId)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Host MCP forwarding failed.", { cause }).pipe(Effect.as([])),
        ),
      );
    return [{ server: GUEST_TOOLS_SERVER, tools } satisfies AppTools, ...forwarded];
  });

  return GuestTools.of({ forThread });
});

/** Needs GuestStore, GuestArtifacts, CodexImages, HostMcpForward and the projection store. */
export const layer = Layer.effect(GuestTools, make);
