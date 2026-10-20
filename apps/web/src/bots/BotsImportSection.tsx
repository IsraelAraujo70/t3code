import { useAtomValue } from "@effect/atom-react";
import type { BotsImportResult, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { botsEnvironment } from "../state/bots";
import { useAtomCommand } from "../state/use-atom-command";
import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { commandFailureMessage } from "./botsSettingsShared";

const ABOUT_ME_PLAN: Record<BotsImportResult["aboutMe"], string> = {
  none: "friend has no About me.",
  same: "About me already matches.",
  replace: "About me will be copied from friend.",
  "keep-local": "Your About me is kept; friend's is skipped.",
};

const ABOUT_ME_APPLIED: Record<BotsImportResult["aboutMe"], string> = {
  ...ABOUT_ME_PLAN,
  replace: "About me was copied from friend.",
};

/**
 * Imports bots, memories, and About me from the friend app's database on the server's machine.
 * Preview plans without writing; Import applies the same path and shows what happened.
 */
export function BotsImportSection({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const canImport = useAtomValue(botsEnvironment.importFriend.permissionAtom(environmentId));
  const runImport = useAtomCommand(botsEnvironment.importFriend, { label: "bots import" });
  const [path, setPath] = useState("");
  const [result, setResult] = useState<BotsImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const disabled = busy !== null || !connected || !canImport;

  const run = async (apply: boolean) => {
    if (disabled) return;
    setBusy(apply ? "import" : "preview");
    setError(null);
    const trimmed = path.trim();
    const outcome = await runImport({
      environmentId,
      input: trimmed ? { path: trimmed, apply } : { apply },
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      setError(commandFailureMessage(outcome));
      return;
    }
    setResult(outcome.value);
  };

  const canApply = result !== null && !result.applied;

  return (
    <SettingsSection {...searchableSetting("bots-import")}>
      <SettingsRow
        title="Database"
        description="Leave empty to use friend's default database on this environment."
        control={
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              font="mono"
              aria-label="friend database path"
              placeholder="~/.local/share/friend/friend.db"
              value={path}
              disabled={busy !== null}
              onChange={(event) => {
                setPath(event.target.value);
                setResult(null);
              }}
            />
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run(false)}>
              {busy === "preview" ? "Checking…" : "Preview"}
            </Button>
            <Button size="sm" disabled={disabled || !canApply} onClick={() => void run(true)}>
              {busy === "import" ? "Importing…" : "Import"}
            </Button>
          </div>
        }
      />
      {error ? (
        <SettingsRow
          title="Import failed"
          description={<span className="text-destructive">{error}</span>}
          role="alert"
        />
      ) : null}
      {result ? <ImportResultRows result={result} /> : null}
    </SettingsSection>
  );
}

function ImportResultRows({ result }: { readonly result: BotsImportResult }) {
  const newBots = result.bots.filter((bot) => bot.status === "new").length;
  return (
    <>
      <SettingsRow
        title={result.applied ? "Imported" : "Import plan"}
        description={
          <span className="break-all">
            {result.path} · {newBots} new {newBots === 1 ? "bot" : "bots"} ·{" "}
            {(result.applied ? ABOUT_ME_APPLIED : ABOUT_ME_PLAN)[result.aboutMe]}
          </span>
        }
        role="status"
      />
      {result.bots.length === 0 ? (
        <SettingsRow title="No bots found in friend" />
      ) : (
        result.bots.map((bot) => (
          <SettingsRow
            key={bot.sourceId}
            title={
              <span className="flex items-center gap-2">
                <span aria-hidden>{bot.emoji}</span>
                {bot.name}
              </span>
            }
            description={`${bot.memories} ${bot.memories === 1 ? "memory" : "memories"}`}
            control={
              <Badge variant={bot.status === "new" ? "info" : "outline"}>
                {bot.status === "new" ? (result.applied ? "Added" : "New") : "Already here"}
              </Badge>
            }
          />
        ))
      )}
      {[...new Set(result.warnings)].map((warning) => (
        <SettingsRow
          key={warning}
          title="Warning"
          description={<span className="text-warning-foreground">{warning}</span>}
        />
      ))}
    </>
  );
}
