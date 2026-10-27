import { useAtomValue } from "@effect/atom-react";
import {
  BOT_LIMITS,
  type BotDirectoryEntry,
  type BotId,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { botsEnvironment, useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { useEnvironments } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Textarea } from "../components/ui/textarea";
import { BotAvatar } from "./BotAvatar";
import { BotEditorDialog } from "./BotEditorDialog";
import { BotMemories } from "./BotMemories";
import { BotsImportSection } from "./BotsImportSection";
import { VoiceSettingsSection } from "./VoiceSettingsSection";
import { KanbanSettingsSection } from "./kanban/KanbanSettingsSection";
import {
  confirmDestructive,
  modelLabel,
  reportCommandResult,
  useRestartBotSession,
} from "./botsSettingsShared";

/**
 * Settings → Bots. Bots live on one machine, so the page always edits the environment that hosts
 * them (it advertises the `bots` capability), whatever the settings scope selects.
 */
export function BotsSettings() {
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
            <EmptyTitle>Bots host not connected</EmptyTitle>
            <EmptyDescription>
              Bots live on one machine. Connect to it to manage them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsPageContainer>
    );
  }
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  return (
    <BotsEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      connected={connected}
    />
  );
}

function BotsEnvironmentSettings({
  environmentId,
  environmentLabel,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
}) {
  const { directory, error } = useBotDirectory(connected ? environmentId : null);
  const canCreate = useAtomValue(botsEnvironment.createBot.permissionAtom(environmentId));
  // The editor holds an id, not an entry, so it always renders the live bot.
  const [editor, setEditor] = useState<{ readonly botId: BotId | null } | null>(null);
  const editedBot =
    editor?.botId != null ? (directory?.bots.find((bot) => bot.id === editor.botId) ?? null) : null;

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("bots")}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!connected || !canCreate || directory === null}
            onClick={() => setEditor({ botId: null })}
          >
            <PlusIcon className="size-3" />
            New bot
          </Button>
        }
      >
        {!connected ? (
          <SettingsRow
            title="Environment disconnected"
            description={`Reconnect ${environmentLabel} to manage its bots.`}
          />
        ) : error ? (
          <SettingsRow title="Could not load bots" description={error} role="alert" />
        ) : directory === null ? (
          <SettingsRow title="Loading bots…" role="status" />
        ) : directory.bots.length === 0 ? (
          <SettingsRow
            title="No bots yet"
            description="Create one to give it a role and a model."
          />
        ) : (
          directory.bots.map((bot) => (
            <BotRow
              key={bot.id}
              environmentId={environmentId}
              connected={connected}
              bot={bot}
              onEdit={() => setEditor({ botId: bot.id })}
            />
          ))
        )}
      </SettingsSection>
      {connected && directory !== null ? (
        <AboutMeSection
          environmentId={environmentId}
          connected={connected}
          aboutMe={directory.aboutMe}
        />
      ) : null}
      <VoiceSettingsSection environmentId={environmentId} connected={connected} />
      {connected ? (
        <KanbanSettingsSection
          environmentId={environmentId}
          connected={connected}
          bots={directory?.bots ?? []}
        />
      ) : null}
      <BotsImportSection environmentId={environmentId} connected={connected} />
      {editor ? (
        <BotEditorDialog
          key={editor.botId ?? "new"}
          environmentId={environmentId}
          connected={connected}
          bot={editedBot}
          editing={editor.botId !== null}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function BotRow({
  environmentId,
  connected,
  bot,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly bot: BotDirectoryEntry;
  readonly onEdit: () => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canUpdate = useAtomValue(botsEnvironment.updateBot.permissionAtom(environmentId));
  const canReset = useAtomValue(botsEnvironment.resetConversation.permissionAtom(environmentId));
  const canRestart = useAtomValue(botsEnvironment.restartSession.permissionAtom(environmentId));
  const restartSession = useRestartBotSession();
  const canDelete = useAtomValue(botsEnvironment.deleteBot.permissionAtom(environmentId));
  const reset = useAtomCommand(botsEnvironment.resetConversation, {
    label: "bot reset conversation",
  });
  const remove = useAtomCommand(botsEnvironment.deleteBot, { label: "bot delete" });
  const [busy, setBusy] = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const enabledMemories = bot.memories.filter((memory) => memory.enabled).length;

  const act = async (action: "reset" | "delete") => {
    if (busy) return;
    const confirmed = await confirmDestructive(
      action === "reset"
        ? `Reset ${bot.name}'s conversation?\nThe current conversation is archived and a new one starts.`
        : `Delete ${bot.name}?\nThis can't be undone.`,
    );
    if (!confirmed) return;
    setBusy(true);
    const result =
      action === "reset"
        ? await reset({ environmentId, input: { botId: bot.id } })
        : await remove({ environmentId, input: { botId: bot.id } });
    setBusy(false);
    reportCommandResult(
      action === "reset" ? "Could not reset conversation" : "Could not delete bot",
      result,
    );
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <BotAvatar botId={bot.id} size={20} />
          {bot.name}
        </span>
      }
      description={modelLabel(providers, bot.model)}
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={memoriesOpen}
            onClick={() => setMemoriesOpen((open) => !open)}
          >
            {memoriesOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            Memories ({enabledMemories}/{bot.memories.length})
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !connected}
                  aria-label={`Actions for ${bot.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={!canUpdate} onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem
                disabled={!canRestart}
                onClick={() => void restartSession(environmentId, bot)}
              >
                <RefreshCwIcon />
                Restart session
              </MenuItem>
              <MenuItem disabled={!canReset} onClick={() => void act("reset")}>
                <RotateCcwIcon />
                Reset conversation
              </MenuItem>
              <MenuSeparator />
              <MenuItem disabled={!canDelete} onClick={() => void act("delete")}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    >
      {memoriesOpen ? (
        <BotMemories environmentId={environmentId} connected={connected} bot={bot} />
      ) : null}
    </SettingsRow>
  );
}

function AboutMeSection({
  environmentId,
  connected,
  aboutMe,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly aboutMe: string;
}) {
  const canUpdate = useAtomValue(botsEnvironment.updateOwner.permissionAtom(environmentId));
  const updateOwner = useAtomCommand(botsEnvironment.updateOwner, { label: "bots owner update" });
  // Null while unedited, so the text follows the live profile until the user types.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? aboutMe;
  const dirty = draft !== null && draft !== aboutMe;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    const result = await updateOwner({ environmentId, input: { aboutMe: value } });
    setSaving(false);
    if (reportCommandResult("Could not save About me", result)) setDraft(null);
  };

  return (
    <SettingsSection {...searchableSetting("bots-about-me")}>
      <SettingsRow
        title="About you"
        description="Every bot reads this before it answers."
        status={`${value.length}/${BOT_LIMITS.aboutMe}`}
      >
        <div className="space-y-2">
          <Textarea
            rows={5}
            aria-label="About me"
            placeholder="Who you are, what you work on, how you like answers."
            maxLength={BOT_LIMITS.aboutMe}
            disabled={saving || !connected || !canUpdate}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            {dirty ? (
              <Button size="xs" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
                Discard
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!dirty || saving || !connected || !canUpdate}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
