import { assert, describe, it } from "@effect/vitest";

import {
  generatedImageType,
  imageThreadStart,
  imageTurnInput,
  stepImageTurn,
  type ImageTurnState,
} from "./CodexImages.ts";

const running: ImageTurnState = { status: "running", image: null };
const item = (
  method: string,
  type: string,
  extra: Record<string, unknown> = {},
  threadId = "t1",
) => ({
  method,
  params: { threadId, item: { id: "i", type, ...extra } },
});
const completed = (threadId = "t1") => ({
  method: "turn/completed",
  params: { threadId, turn: { id: "turn", status: "completed", error: null } },
});

const run = (notifications: ReadonlyArray<{ method: string; params?: unknown }>) =>
  notifications.reduce<ImageTurnState>(
    (state, notification) => stepImageTurn(state, "t1", notification),
    running,
  );

describe("stepImageTurn", () => {
  it("returns the image once the turn completes", () => {
    assert.deepStrictEqual(
      run([
        item("item/started", "userMessage"),
        item("item/started", "reasoning"),
        item("item/started", "imageGeneration", { result: "" }),
        item("item/completed", "imageGeneration", { result: "iVBO", revisedPrompt: "a cat" }),
        item("item/completed", "agentMessage", { text: "Pronto." }),
        completed(),
      ]),
      { status: "done", base64: "iVBO", revisedPrompt: "a cat" },
    );
  });

  it("fails as soon as any other tool starts, before it runs", () => {
    for (const type of [
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "collabAgentToolCall",
      "webSearch",
      "imageView",
    ]) {
      const state = run([item("item/started", type), completed()]);
      assert.strictEqual(state.status, "failed", type);
      assert.include(state.status === "failed" ? state.message : "", type);
    }
  });

  it("fails on an item it cannot read rather than letting it pass", () => {
    assert.strictEqual(run([{ method: "item/started", params: { item: 42 } }]).status, "failed");
  });

  it("ignores other threads and keeps the first outcome", () => {
    const otherThread = run([item("item/started", "commandExecution", {}, "t2"), completed("t2")]);
    assert.deepStrictEqual(otherThread, running);
    const failed = run([item("item/started", "fileChange"), completed()]);
    assert.strictEqual(stepImageTurn(failed, "t1", completed()), failed);
  });

  it("explains a used-up plan and a turn without an image", () => {
    const quota = run([
      item("item/completed", "imageGeneration", {
        result: "",
        failure: { type: "usageLimitExceeded", limitId: "codex", resetsAt: 1_800_000_000 },
      }),
    ]);
    assert.strictEqual(quota.status, "failed");
    assert.include(quota.status === "failed" ? quota.message : "", "2027-01-15");
    assert.strictEqual(run([item("item/completed", "agentMessage"), completed()]).status, "failed");
    assert.strictEqual(
      run([
        { method: "error", params: { threadId: "t1", error: { message: "x" }, willRetry: true } },
      ]).status,
      "running",
    );
  });
});

describe("imageThreadStart", () => {
  it("disables every configured MCP server and every tool feature but image generation", () => {
    const start = imageThreadStart("/state/guest-images", { whatsapp: {}, linear: {} });
    assert.strictEqual(start.ephemeral, true);
    assert.strictEqual(start.sandbox, "read-only");
    assert.strictEqual(start.approvalPolicy, "never");
    assert.deepStrictEqual(start.config.mcp_servers, {
      whatsapp: { enabled: false },
      linear: { enabled: false },
    });
    const features: Record<string, boolean> = start.config.features;
    assert.isTrue(features.image_generation);
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "view_image",
      "hooks",
    ]) {
      assert.isFalse(features[feature], feature);
    }
    assert.strictEqual(start.config.web_search, "disabled");
  });
});

describe("imageTurnInput", () => {
  it("sends the images inline as data URLs, never as paths", () => {
    const [text, image] = imageTurnInput("chapéu", [
      { mimeType: "image/png", bytes: new Uint8Array([1]) },
    ]);
    assert.deepStrictEqual(image, { type: "image", url: "data:image/png;base64,AQ==" });
    assert.include(text?.type === "text" ? text.text : "", "chapéu");
  });
});

describe("generatedImageType", () => {
  it("reads the type from the bytes", () => {
    assert.strictEqual(
      generatedImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      "image/png",
    );
    assert.strictEqual(generatedImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.isNull(generatedImageType(new TextEncoder().encode("<svg></svg>")));
  });
});
