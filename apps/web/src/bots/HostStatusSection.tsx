import type { BotsHostStatus } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";

/**
 * Settings → Bots → This host: what the bots host was started with. These live in the host's
 * environment, not in Settings, because they hold secrets or describe the machine; each row says
 * what turns it on.
 */
export function HostStatusSection({
  status,
  bots,
}: {
  readonly status: BotsHostStatus;
  readonly bots: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}) {
  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  return (
    <SettingsSection {...searchableSetting("bots-host")}>
      <p className="px-1 text-xs text-muted-foreground">
        Read when the bots host started. Change them in its environment and restart it.
      </p>
      <SettingsRow
        title="Dictation"
        status={<OnOff on={status.openRouter} />}
        description={
          status.openRouter
            ? "Voice messages are transcribed on this host, and the kanban AI filter works."
            : hint("OPENROUTER_API_KEY", "to transcribe voice messages and filter the kanban by AI")
        }
      />
      <SettingsRow
        title="Android notifications"
        status={<OnOff on={status.androidPush && status.androidPushIssue === null} />}
        description={
          status.androidPushIssue ??
          (status.androidPush
            ? "Bot replies reach the Android app as push notifications."
            : hint(
                "T3CODE_FCM_SERVICE_ACCOUNT_FILE",
                "to a Firebase service account key to push bot replies to Android",
              ))
        }
      />
      <SettingsRow
        title="Public webhook URL"
        status={<OnOff on={status.webhookPublicBaseUrl !== null} />}
        description={
          status.webhookPublicBaseUrl ??
          hint(
            "T3CODE_WEBHOOK_PUBLIC_BASE_URL",
            "to an https origin that forwards /api/hooks here, for webhook tasks without T3 Connect",
          )
        }
      />
      <SettingsRow
        title="Linear sync"
        status={<OnOff on={status.kanbanPollSeconds > 0} />}
        description={
          status.kanbanPollSeconds > 0
            ? `Every ${status.kanbanPollSeconds} s (T3CODE_KANBAN_POLL_SECONDS).`
            : "Off: T3CODE_KANBAN_POLL_SECONDS is 0."
        }
      />
      <SettingsRow
        title="Host MCP servers"
        status={<OnOff on={status.hostMcp.length > 0} />}
        description={
          status.hostMcp.length > 0 ? (
            <ul className="space-y-0.5">
              {status.hostMcp.map((entry) => (
                <li key={entry.botId}>
                  {botName(entry.botId)}: {entry.servers.join(", ")}
                </li>
              ))}
            </ul>
          ) : (
            "Give a bot the tools of an MCP server on this machine in ~/.t3-friend/bot-host-mcp.json (or T3CODE_BOT_HOST_MCP_FILE)."
          )
        }
      />
    </SettingsSection>
  );
}

function OnOff({ on }: { readonly on: boolean }) {
  return (
    <span className={on ? "text-foreground" : "text-muted-foreground"}>{on ? "On" : "Off"}</span>
  );
}

const hint = (env: string, purpose: string): ReactNode => (
  <>
    Set <code className="font-mono text-2xs">{env}</code> {purpose}.
  </>
);
