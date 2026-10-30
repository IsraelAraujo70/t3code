import {
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  type EnvironmentId,
  VSCODE_BASE_PATH,
  VSCODE_COLOR_SCHEME_PARAM,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSession } from "../../state/session";

// Same access as the Computer stream: a cookie session sends its cookie, a bearer session (the
// desktop app on a remote environment) carries a one-time `wsTicket` the server trades for a cookie.
const vsCodeAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: `${VSCODE_BASE_PATH}/` });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`vscode-access:${environmentId}`)),
);

/**
 * VS Code on `folder` in this environment, through the environment's own address so it works
 * from a remote client, opening in T3's `colorScheme`. Null when the environment is not connected.
 */
export function readVsCodeUrl(
  environmentId: EnvironmentId,
  folder: string,
  colorScheme: "light" | "dark",
): Promise<string | null> {
  const atom = vsCodeAccessAtom(environmentId);
  // A ticket is spent on the first load, so every new frame asks for a fresh one.
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.map((access) => {
        const url = new URL(withDeviceHubQuery(access.httpBase, access));
        url.searchParams.set("folder", folder);
        url.searchParams.set(VSCODE_COLOR_SCHEME_PARAM, colorScheme);
        return url.toString();
      }),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
