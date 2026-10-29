import { isUpdateAvailable, type SelfUpdate } from "@t3tools/client-runtime/app-self-update";
import { useEffect, useSyncExternalStore } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { InlineButton } from "../components/ui/button";
import { useBotsEnvironmentId } from "../state/bots";
import { desktopSelfUpdate, setDesktopSelfUpdateTarget } from "./desktopSelfUpdate";

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

/**
 * The fork Mac app's "update available" line in the sidebar footer. It also runs the checks: when
 * the bots host connects, and when the window regains focus (at most every 15 minutes). Renders
 * nothing outside a fork Mac build.
 */
export function DesktopSelfUpdateNotice() {
  return desktopSelfUpdate === null ? null : <Notice update={desktopSelfUpdate} />;
}

function Notice({ update }: { readonly update: SelfUpdate }) {
  const environmentId = useBotsEnvironmentId();
  const snapshot = useSyncExternalStore(update.subscribe, update.getSnapshot);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Points the self-updater at the connected bots host and checks it when it connects.
  useEffect(() => {
    setDesktopSelfUpdateTarget(environmentId);
    if (environmentId !== null) void update.check("launch");
  }, [update, environmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Window focus listener re-checks for updates.
  useEffect(() => {
    const onFocus = () => void update.check("foreground");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [update]);

  const { latest, phase, error } = snapshot;
  if (!isUpdateAvailable(snapshot.embedded, latest)) return null;
  const busy = phase.type !== "idle";
  if (!busy && error === null && snapshot.dismissedCommit === latest.commit) return null;

  const status =
    phase.type === "downloading"
      ? `Baixando${phase.fraction === null ? "…" : ` ${Math.floor(phase.fraction * 100)}%`}`
      : phase.type === "verifying"
        ? "Conferindo…"
        : phase.type === "installing"
          ? "Instalando…"
          : null;

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        Atualização do app: {latest.shortCommit} · {day(latest.commitDate)}
        {status !== null ? (
          <> · {status}</>
        ) : (
          <>
            {" "}
            <InlineButton onClick={() => void update.install()}>
              {error === null ? "Atualizar" : "Tentar de novo"}
            </InlineButton>{" "}
            <InlineButton onClick={update.dismiss}>Agora não</InlineButton>
          </>
        )}
        {error !== null && !busy ? <span className="block">{error}</span> : null}
      </AlertDescription>
    </Alert>
  );
}
