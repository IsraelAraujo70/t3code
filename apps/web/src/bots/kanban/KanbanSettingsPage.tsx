import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useBotDirectory, useBotsEnvironmentId } from "../../state/bots";
import { useEnvironments } from "../../state/environments";
import { SettingsPageContainer, SettingsRow } from "../../components/settings/settingsLayout";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { KanbanSettingsSection } from "./KanbanSettingsSection";

/** Edits kanban configuration on the bots host. */
export function KanbanSettingsPage() {
  const hostId = useBotsEnvironmentId();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === hostId) ?? null;
  if (!environment) {
    return (
      <SettingsPageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>Kanban needs a bots host</EmptyTitle>
            <EmptyDescription>
              The kanban lives on the machine that hosts your bots. Turn bots on there, then connect
              to it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsPageContainer>
    );
  }
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  return (
    <KanbanEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      connected={connected}
    />
  );
}

function KanbanEnvironmentSettings({
  environmentId,
  environmentLabel,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
}) {
  const { directory, error } = useBotDirectory(connected ? environmentId : null);
  return (
    <SettingsPageContainer>
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environmentLabel} to manage its kanban.`}
        />
      ) : (
        <>
          {error ? (
            <SettingsRow title="Could not load bots" description={error} role="alert" />
          ) : null}
          <KanbanSettingsSection
            environmentId={environmentId}
            connected={connected}
            bots={directory?.bots ?? []}
          />
        </>
      )}
    </SettingsPageContainer>
  );
}
