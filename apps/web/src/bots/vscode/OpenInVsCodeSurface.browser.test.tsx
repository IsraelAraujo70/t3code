import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  EnvironmentId,
  ThreadId,
  type EditorId,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render as renderUi } from "../../../test/render";
import type { RemoteOpenState } from "../../remoteOpen";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";

const state = vi.hoisted(() => ({
  orchestration: new Set<string>(),
  terminal: new Set<string>(),
  vscodeServed: false,
  remote: { mode: "local-exec" } as RemoteOpenState,
  run: vi.fn(),
}));

vi.mock(import("../../state/session"), async (importOriginal) => {
  const readEnvironmentScope = (environmentId: string, scope: string) =>
    (scope === AuthOrchestrationOperateScope && state.orchestration.has(environmentId)) ||
    (scope === AuthTerminalOperateScope && state.terminal.has(environmentId));
  return {
    ...(await importOriginal()),
    readEnvironmentScope: readEnvironmentScope as never,
    useEnvironmentScope: readEnvironmentScope as never,
  };
});
vi.mock(import("../../state/server"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Atom } = await import("effect/reactivity");
  const config = (vscode: boolean) =>
    Atom.make(() => ({ environment: { capabilities: { vscode } } }));
  const served = config(true);
  const unserved = config(false);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => (state.vscodeServed ? served : unserved)) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({ label: "Test host" })) as never,
}));
vi.mock(import("../../remoteOpen"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRemoteOpenState: () => state.remote,
  useRemoteCapableEditors: () => ["vscode"] as readonly EditorId[],
  useRemoteOpenHint: () => [false, () => undefined] as const,
}));

import { OpenInPicker } from "../../components/chat/OpenInPicker";
import {
  registerOpenFavoriteEditorCommand,
  useOpenFavoriteEditorShortcut,
} from "../../components/chat/OpenInPickerShortcut";

const environment = EnvironmentId.make("vps");
const thread = ThreadId.make("thread");
const editors: readonly EditorId[] = ["vscode"];

async function setup({ served = true, terminal = true } = {}) {
  state.orchestration = new Set([environment]);
  state.terminal = new Set(terminal ? [environment] : []);
  state.vscodeServed = served;
  state.remote = { mode: "local-exec" };
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  useRightPanelStore.setState({ byThreadKey: {} });
  window.localStorage.clear();

  await using stack = new AsyncDisposableStack();
  const _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  stack.use(_platform);
  const _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
  stack.use(_storage);
  // The app registers this command at startup (appInit).
  const _openFavorite = { [Symbol.dispose]: registerOpenFavoriteEditorCommand() };
  stack.use(_openFavorite);
  const screen = stack.use(await renderUi(null));
  const disposables = stack.move();
  return { screen, [Symbol.asyncDispose]: () => disposables.disposeAsync() };
}

async function renderPicker(screen: Awaited<ReturnType<typeof setup>>["screen"]) {
  await act(async () =>
    screen.rerender(
      <OpenInPicker
        environmentId={environment}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        availableEditors={editors}
        openInCwd="/work/project"
        displayMode="panel"
        surfaceThreadId={thread}
      />,
    ),
  );
}

function FavoriteEditorFallback() {
  useOpenFavoriteEditorShortcut({
    enabled: true,
    environmentId: environment,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    availableEditors: editors,
    openInCwd: "/work/project",
    surfaceThreadId: thread,
  });
  return null;
}

function byLabel(label: string) {
  const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
}

const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const click = (element: HTMLElement) => act(async () => element.click());
const panel = () =>
  selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    scopeThreadRef(environment, thread),
  );

describe("Open in VS Code in T3", () => {
  it("opens the thread's VS Code surface by default; an external editor stays a choice", async () => {
    await using fixture = await setup();
    await renderPicker(fixture.screen);

    await click(byLabel("Open VS Code in T3"));
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "vscode" });
    expect(state.run).not.toHaveBeenCalled();

    await click(byLabel("Choose editor"));
    expect(menuItems().map((item) => item.textContent)).toEqual(["VS Code in T3Ctrl+O", "VS Code"]);
    await click(menuItems()[1]!);
    await click(byLabel("Open in VS Code"));
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ editor: "vscode" }) }),
    );

    await click(byLabel("Choose editor"));
    await click(menuItems()[0]!);
    expect(byLabel("Open VS Code in T3")).toBeTruthy();
  });

  it.each([
    { case: "the environment does not serve VS Code", served: false, terminal: true },
    { case: "the session lacks terminal:operate", served: true, terminal: false },
  ])("keeps the external editor when $case", async ({ served, terminal }) => {
    await using fixture = await setup({ served, terminal });
    await renderPicker(fixture.screen);

    await click(byLabel("Open in VS Code"));
    expect(state.run).toHaveBeenCalledTimes(1);
    await click(byLabel("Choose editor"));
    expect(menuItems().map((item) => item.textContent)).toEqual(["VS CodeCtrl+O"]);
    expect(panel().surfaces).toEqual([]);
  });

  it("opens the surface from the favorite-editor shortcut with no picker on screen", async () => {
    await using fixture = await setup();
    // A remote environment with no SSH route: the external editor could not open at all.
    state.remote = { mode: "remote-unavailable" };
    await act(async () => fixture.screen.rerender(<FavoriteEditorFallback />));

    const event = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.body.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "vscode" });
    expect(state.run).not.toHaveBeenCalled();
  });
});
