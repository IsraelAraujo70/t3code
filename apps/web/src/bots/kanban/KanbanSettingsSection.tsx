import { useAtomValue } from "@effect/atom-react";
import {
  KANBAN_LIMITS,
  type BotDirectoryEntry,
  type BotId,
  type EnvironmentId,
  type KanbanProjectLink,
  type KanbanSnapshot,
  type KanbanWorkspace,
  type LinearAccount,
  type LinearAccountId,
  type LinearTeamSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { LinkIcon, PlusIcon, Trash2Icon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { botsEnvironment, useKanbanSnapshot } from "../../state/bots";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { BotAvatar } from "../BotAvatar";
import { BotsField, confirmDestructive, reportCommandResult } from "../botsSettingsShared";

/**
 * Settings → Bots → Kanban: Linear accounts (a name and a personal API key each), which project
 * shows which Linear team, and the bots responsible for each workspace.
 */
export function KanbanSettingsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly bots: ReadonlyArray<BotDirectoryEntry>;
}) {
  const { snapshot, error } = useKanbanSnapshot(props.connected ? props.environmentId : null);
  return (
    <SettingsSection id="kanban" title="Kanban & Linear">
      {error ? (
        <SettingsRow title="Could not load the kanban" description={error} role="alert" />
      ) : snapshot === null ? (
        <SettingsRow title="Loading the kanban…" role="status" />
      ) : (
        <>
          <AccountsRows environmentId={props.environmentId} snapshot={snapshot} />
          <ProjectLinksRow environmentId={props.environmentId} snapshot={snapshot} />
          <AllWorkspacesBotsRow
            environmentId={props.environmentId}
            allWorkspacesBotIds={snapshot.allWorkspacesBotIds}
            bots={props.bots}
          />
          {snapshot.workspaces.map((workspace) => (
            <WorkspaceBotsRow
              key={workspace.id}
              environmentId={props.environmentId}
              workspace={workspace}
              allWorkspacesBotIds={snapshot.allWorkspacesBotIds}
              bots={props.bots}
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

function AccountsRows(props: { environmentId: EnvironmentId; snapshot: KanbanSnapshot }) {
  const { environmentId } = props;
  const canEdit = useAtomValue(botsEnvironment.kanbanAddAccount.permissionAtom(environmentId));
  const add = useAtomCommand(botsEnvironment.kanbanAddAccount, { label: "add Linear account" });
  const remove = useAtomCommand(botsEnvironment.kanbanDeleteAccount, {
    label: "delete Linear account",
  });
  const [draft, setDraft] = useState<{ name: string; apiKey: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    const result = await add({
      environmentId,
      input: { name: draft.name.trim(), apiKey: draft.apiKey.trim() },
    });
    setSaving(false);
    if (reportCommandResult("Could not add the Linear account", result)) setDraft(null);
  };

  const deleteAccount = async (account: LinearAccount) => {
    const linked = props.snapshot.links.filter((link) => link.accountId === account.id).length;
    const ok = await confirmDestructive(
      `Remove ${account.name}?\nIts API key is deleted from the server${linked > 0 ? ` and ${linked} linked project${linked === 1 ? "" : "s"} go back to a local board` : ""}.`,
    );
    if (!ok) return;
    reportCommandResult(
      "Could not remove the Linear account",
      await remove({ environmentId, input: { accountId: account.id } }),
    );
  };

  return (
    <>
      <SettingsRow
        title="Linear accounts"
        description="Each account is a personal API key (Linear → Settings → Security & access). A key belongs to one user in one workspace, so add one per workspace or per user. The key stays on the server."
        control={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canEdit || draft !== null}
            onClick={() => setDraft({ name: "", apiKey: "" })}
          >
            <PlusIcon className="size-3" />
            Add account
          </Button>
        }
      >
        {props.snapshot.accounts.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {props.snapshot.accounts.map((account) => (
              <li key={account.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{account.name}</span>
                <span className="text-muted-foreground text-xs">
                  {account.userName} · {account.organizationName} · key ••••{account.keyLast4}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  className="ml-auto"
                  aria-label={`Remove ${account.name}`}
                  disabled={!canEdit}
                  onClick={() => void deleteAccount(account)}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {draft !== null ? (
          <form
            className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <BotsField label="Name" htmlFor="linear-account-name">
              <Input
                id="linear-account-name"
                size="sm"
                autoFocus
                maxLength={KANBAN_LIMITS.accountName}
                placeholder="Work"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </BotsField>
            <BotsField label="API key" htmlFor="linear-account-key">
              <Input
                id="linear-account-key"
                size="sm"
                type="password"
                autoComplete="off"
                maxLength={KANBAN_LIMITS.apiKey}
                placeholder="lin_api_…"
                value={draft.apiKey}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </BotsField>
            <div className="flex gap-1">
              <Button size="xs" variant="ghost" type="button" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                type="submit"
                disabled={saving || draft.name.trim() === "" || draft.apiKey.trim() === ""}
              >
                {saving ? "Checking…" : "Add"}
              </Button>
            </div>
          </form>
        ) : null}
      </SettingsRow>
    </>
  );
}

function ProjectLinksRow(props: { environmentId: EnvironmentId; snapshot: KanbanSnapshot }) {
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  return (
    <SettingsRow
      title="Projects"
      description="A project linked to a Linear team shows that team's issues and columns, synced every minute. Moving a card moves the issue in Linear. An unlinked project has a local board."
    >
      <ul className="mt-2 space-y-1.5">
        {projects.map((project) => (
          <ProjectLinkItem
            key={project.id}
            environmentId={props.environmentId}
            snapshot={props.snapshot}
            projectId={project.id}
            projectTitle={project.title}
            link={props.snapshot.links.find((link) => link.projectId === project.id) ?? null}
          />
        ))}
      </ul>
    </SettingsRow>
  );
}

function ProjectLinkItem(props: {
  environmentId: EnvironmentId;
  snapshot: KanbanSnapshot;
  projectId: ProjectId;
  projectTitle: string;
  link: KanbanProjectLink | null;
}) {
  const { environmentId, link } = props;
  const canEdit = useAtomValue(botsEnvironment.kanbanLinkProject.permissionAtom(environmentId));
  const loadTeams = useAtomCommand(botsEnvironment.kanbanLinearTeams, { label: "Linear teams" });
  const linkProject = useAtomCommand(botsEnvironment.kanbanLinkProject, { label: "link project" });
  const unlinkProject = useAtomCommand(botsEnvironment.kanbanUnlinkProject, {
    label: "unlink project",
  });
  const [editing, setEditing] = useState<{
    accountId: LinearAccountId | null;
    teams: ReadonlyArray<LinearTeamSummary> | null;
    teamId: string | null;
    linearProjectId: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const accountName = (accountId: string) =>
    props.snapshot.accounts.find((account) => account.id === accountId)?.name ?? "Unknown account";

  const chooseAccount = async (accountId: LinearAccountId) => {
    setEditing({ accountId, teams: null, teamId: null, linearProjectId: null });
    const result = await loadTeams({ environmentId, input: { accountId } });
    if (
      !reportCommandResult("Could not list the Linear teams", result) ||
      result._tag !== "Success"
    ) {
      // Back to picking an account, so the row does not stay on "Loading teams…".
      setEditing((current) =>
        current?.accountId === accountId ? { ...current, accountId: null } : current,
      );
      return;
    }
    setEditing((current) =>
      current?.accountId === accountId ? { ...current, teams: result.value.teams } : current,
    );
  };

  const save = async () => {
    if (editing?.accountId == null || editing.teamId === null) return;
    setBusy(true);
    const result = await linkProject({
      environmentId,
      input: {
        projectId: props.projectId,
        accountId: editing.accountId,
        teamId: editing.teamId,
        linearProjectId: editing.linearProjectId,
      },
    });
    setBusy(false);
    if (reportCommandResult("Could not link the project", result)) setEditing(null);
  };

  const unlink = async () => {
    const ok = await confirmDestructive(
      `Unlink ${props.projectTitle}?\nIts Linear tickets leave the board; nothing changes in Linear.`,
    );
    if (!ok) return;
    reportCommandResult(
      "Could not unlink the project",
      await unlinkProject({ environmentId, input: { projectId: props.projectId } }),
    );
  };

  const team = editing?.teams?.find((candidate) => candidate.id === editing.teamId) ?? null;
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-32 font-medium">{props.projectTitle}</span>
      {editing === null ? (
        <>
          <span className="text-muted-foreground text-xs">
            {link === null
              ? "Local board"
              : `${link.teamName}${link.linearProjectName ? ` · ${link.linearProjectName}` : ""} via ${accountName(link.accountId)}${link.syncError ? ` · sync failed: ${link.syncError}` : link.lastSyncedAt ? ` · synced ${formatRelativeTimeLabel(link.lastSyncedAt)}` : ""}`}
          </span>
          <div className="ml-auto flex gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canEdit || props.snapshot.accounts.length === 0}
              onClick={() =>
                setEditing({ accountId: null, teams: null, teamId: null, linearProjectId: null })
              }
            >
              <LinkIcon className="size-3" />
              {link === null ? "Link to Linear" : "Change"}
            </Button>
            {link !== null ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canEdit}
                onClick={() => void unlink()}
              >
                <UnlinkIcon className="size-3" />
                Unlink
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            value={editing.accountId ?? ""}
            onValueChange={(value) => value && void chooseAccount(value as LinearAccountId)}
          >
            <SelectTrigger aria-label="Linear account" size="xs" className="min-w-36">
              <SelectValue>
                {editing.accountId ? accountName(editing.accountId) : "Account"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {props.snapshot.accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name} ({account.organizationName})
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {editing.teams !== null ? (
            <Select
              value={editing.teamId ?? ""}
              onValueChange={(value) =>
                value && setEditing({ ...editing, teamId: value, linearProjectId: null })
              }
            >
              <SelectTrigger aria-label="Linear team" size="xs" className="min-w-36">
                <SelectValue>{team ? `${team.name} (${team.key})` : "Team"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {editing.teams.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.key})
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : editing.accountId !== null ? (
            <span className="text-muted-foreground text-xs">Loading teams…</span>
          ) : null}
          {team !== null && team.projects.length > 0 ? (
            <Select
              value={editing.linearProjectId ?? "all"}
              onValueChange={(value) =>
                setEditing({
                  ...editing,
                  linearProjectId: value === null || value === "all" ? null : value,
                })
              }
            >
              <SelectTrigger aria-label="Linear project" size="xs" className="min-w-36">
                <SelectValue>
                  {team.projects.find((project) => project.id === editing.linearProjectId)?.name ??
                    "Whole team"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="all">Whole team</SelectItem>
                {team.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button size="xs" disabled={busy || editing.teamId === null} onClick={() => void save()}>
            {busy ? "Linking…" : "Link"}
          </Button>
        </div>
      )}
    </li>
  );
}

function AllWorkspacesBotsRow(props: {
  environmentId: EnvironmentId;
  allWorkspacesBotIds: ReadonlyArray<BotId>;
  bots: ReadonlyArray<BotDirectoryEntry>;
}) {
  const { environmentId } = props;
  const canEdit = useAtomValue(
    botsEnvironment.kanbanBotAllWorkspaces.permissionAtom(environmentId),
  );
  const setAll = useAtomCommand(botsEnvironment.kanbanBotAllWorkspaces, {
    label: "bot responsible for all workspaces",
  });
  const toggle = async (botId: BotId, allWorkspaces: boolean) =>
    reportCommandResult(
      "Could not change the bot's workspaces",
      await setAll({ environmentId, input: { botId, allWorkspaces } }),
    );
  if (props.bots.length === 0) return null;
  return (
    <SettingsRow
      title="Responsible for all workspaces"
      description="These bots are responsible for every workspace, including local tickets and workspaces added later: their kanban tools read, create, move and comment on any ticket, and edit any saved view."
    >
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {props.bots.map((bot) => (
          <li key={bot.id}>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm">
              <Checkbox
                checked={props.allWorkspacesBotIds.includes(bot.id)}
                disabled={!canEdit}
                onCheckedChange={(checked) => void toggle(bot.id, checked === true)}
              />
              <BotAvatar botId={bot.id} size={16} />
              {bot.name}
            </label>
          </li>
        ))}
      </ul>
    </SettingsRow>
  );
}

function WorkspaceBotsRow(props: {
  environmentId: EnvironmentId;
  workspace: KanbanWorkspace;
  allWorkspacesBotIds: ReadonlyArray<BotId>;
  bots: ReadonlyArray<BotDirectoryEntry>;
}) {
  const { environmentId, workspace } = props;
  const canEdit = useAtomValue(botsEnvironment.kanbanWorkspaceBots.permissionAtom(environmentId));
  const setBots = useAtomCommand(botsEnvironment.kanbanWorkspaceBots, {
    label: "workspace bots",
  });
  const toggle = async (botId: BotId, checked: boolean) => {
    const botIds = checked
      ? [...workspace.botIds, botId]
      : workspace.botIds.filter((candidate) => candidate !== botId);
    reportCommandResult(
      "Could not change the workspace's bots",
      await setBots({ environmentId, input: { workspaceId: workspace.id, botIds } }),
    );
  };
  return (
    <SettingsRow
      title={`Bots responsible for ${workspace.name}`}
      description={
        workspace.id === "local"
          ? "They appear on local tickets and can read, create, move and link them with their kanban tools."
          : `They appear on ${workspace.name}'s tickets and can read, create and move them (in Linear too) and link threads, with their kanban tools.`
      }
    >
      {props.bots.length === 0 ? (
        <p className="mt-2 text-muted-foreground text-xs">No bots yet.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          {props.bots.map((bot) => {
            const everywhere = props.allWorkspacesBotIds.includes(bot.id);
            return (
              <li key={bot.id}>
                <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={everywhere || workspace.botIds.includes(bot.id)}
                    disabled={!canEdit || everywhere}
                    onCheckedChange={(checked) => void toggle(bot.id, checked === true)}
                  />
                  <BotAvatar botId={bot.id} size={16} />
                  {bot.name}
                  {everywhere ? (
                    <span className="text-muted-foreground text-xs">(all workspaces)</span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsRow>
  );
}
