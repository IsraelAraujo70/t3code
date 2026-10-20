import {
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { COMPUTER_STREAM_PATH, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";

// Same access as the preview stream: bearer and DPoP sessions carry a short-lived `wsTicket`.
const computerStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: COMPUTER_STREAM_PATH });
    })
    .pipe(
      Atom.setIdleTTL(60_000),
      Atom.withLabel(`mobile-computer-stream-access:${environmentId}`),
    ),
);

/** The stream URL with fresh credentials, or null when the environment is not connected. */
export function readComputerStreamUrl(
  environmentId: EnvironmentId,
  maxWidth: number,
): Promise<string | null> {
  const atom = computerStreamAccessAtom(environmentId);
  // Tickets expire after a few minutes, so every (re)connect asks for a fresh one.
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.map((access) =>
        withDeviceHubQuery(`${access.wsBase}?maxWidth=${String(maxWidth)}`, access),
      ),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
