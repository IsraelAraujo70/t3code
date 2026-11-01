import { useAtomValue } from "@effect/atom-react";
import { AuthTerminalOperateScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useRightPanelStore } from "../../rightPanelStore";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";

const PREFER_SURFACE_KEY = "t3code:friend:open-in-vscode-surface";

export const VS_CODE_SURFACE_LABEL = "VS Code in T3";

/**
 * The right panel's VS Code as an "Open in" choice for a thread. It is offered where the thread's
 * environment serves VS Code (the `vscode` capability) to a session with terminal:operate, and is
 * the default there until the user picks an external editor; picking it again switches back.
 * `open` does what "Open a surface" → VS Code does: opens the tab, or focuses the one already open.
 */
export function useVsCodeSurfaceEditor(environmentId: EnvironmentId, threadId: ThreadId | null) {
  const served =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .vscode === true;
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [prefersSurface, setPrefersSurface] = useLocalStorage(
    PREFER_SURFACE_KEY,
    true,
    Schema.Boolean,
  );
  const open = (): boolean => {
    if (threadId === null || !readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
      return false;
    }
    useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "vscode");
    return true;
  };
  const available = threadId !== null && served && canOperate;
  return {
    available,
    preferred: available && prefersSurface,
    setPreferred: setPrefersSurface,
    open,
  };
}
