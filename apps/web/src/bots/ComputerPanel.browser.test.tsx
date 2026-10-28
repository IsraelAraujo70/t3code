import { EnvironmentId, type ComputerStreamInput } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { useChatShortcuts } from "../components/chat/useChatShortcuts";
import { shouldRefocusComposerOnWindowFocus } from "../components/ChatView.logic";
import type { ComputerStreamEvents } from "./computerStream";
import { ComputerPanel } from "./ComputerPanel";

const mocks = vi.hoisted(() => ({
  events: null as ComputerStreamEvents | null,
  sent: [] as ComputerStreamInput[],
}));

vi.mock("../state/bots", async () => {
  const { EnvironmentId } = await import("@t3tools/contracts");
  return { useBotsEnvironmentId: () => EnvironmentId.make("bots-host") };
});
vi.mock("../state/environments", () => ({ useEnvironment: () => ({ label: "Omarchy" }) }));
vi.mock("./computerStream", () => ({
  createComputerStreamClient: (_environmentId: EnvironmentId, events: ComputerStreamEvents) => {
    mocks.events = events;
    return { send: (input: ComputerStreamInput) => mocks.sent.push(input), stop: () => {} };
  },
}));

function setup() {
  mocks.events = null;
  mocks.sent = [];
}

// Stands in for the chat around the right panel: its window shortcuts and type-to-focus.
function Chat(props: {
  readonly composerKeys: string[];
  readonly closedPanels: string[];
  readonly children: ReactNode;
}) {
  useChatShortcuts({
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      rightPanelOpen: true,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          props.composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {
      "rightPanel.close": () => {
        props.closedPanels.push("computer");
      },
    },
    fallback: () => undefined,
  });
  return props.children;
}

async function jpegFrame() {
  const canvas = new OffscreenCanvas(4, 3);
  canvas.getContext("2d")?.fillRect(0, 0, 4, 3);
  return (await canvas.convertToBlob({ type: "image/jpeg" })).arrayBuffer();
}

async function goLive(canControl: boolean) {
  await vi.waitFor(() => expect(mocks.events).not.toBeNull());
  const events = mocks.events!;
  events.onAccess(canControl);
  events.onInfo({ type: "info", width: 4, height: 3, screenWidth: 4, screenHeight: 3 });
  const frame = await jpegFrame();
  events.onFrame(frame, () => {});
}

// router: false because neither the panel nor the chat stand-in navigates.
const options = { router: false } as const;

describe("ComputerPanel keyboard", () => {
  it("sends keys to the host while in control, not to the composer", async () => {
    setup();
    const composerKeys: string[] = [];
    const closedPanels: string[] = [];
    await using screen = await render(
      <Chat composerKeys={composerKeys} closedPanels={closedPanels}>
        <ComputerPanel visible />
      </Chat>,
      options,
    );
    await goLive(true);
    await expect.element(screen.getByText("Turn on Control to type on the host")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Control" }));
    const controlled = screen.getByLabelText("Controlling Omarchy");
    await expect.element(controlled).toHaveFocus();

    await userEvent.keyboard("a{Control>}w{/Control}{Escape}");

    await vi.waitFor(() =>
      expect(mocks.sent).toEqual([
        { type: "text", text: "a" },
        { type: "key", key: "w", modifiers: ["ctrl"] },
        { type: "key", key: "Escape", modifiers: [] },
      ]),
    );
    expect(composerKeys).toEqual([]);
    expect(closedPanels).toEqual([]);
    // ChatView's window-focus handler leaves the focused screen alone.
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
  });

  it("says the screen is view only when the host does not allow control", async () => {
    setup();
    await using screen = await render(<ComputerPanel visible />, options);
    await goLive(false);
    await expect.element(screen.getByText("View only")).toBeVisible();
    expect(screen.getByRole("button", { name: "Control" }).query()).toBeNull();
  });
});
