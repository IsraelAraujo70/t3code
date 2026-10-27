import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  THREAD_CARD_STATUS_LABELS,
  threadCardStatus,
  workspaceOf,
  type ThreadCardStatus,
} from "@t3tools/client-runtime/kanban-board";
import { resolveChangeRequestLinkTarget } from "@t3tools/client-runtime/change-request-links";
import type {
  BotDirectoryEntry,
  EnvironmentId,
  KanbanPullRequestRef,
  KanbanSnapshot,
  KanbanTicket,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, LinkIcon, PlayIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  PullRequestDiffStat,
  PullRequestStateGlyph,
  pullRequestChecksStatePresentation,
} from "../../components/pullRequest/pullRequestPresentation";
import { Button } from "../../components/ui/button";
import { Group, GroupSeparator } from "../../components/ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../../components/ui/menu";
import { botsEnvironment, useBotDirectory } from "../../state/bots";
import { useProjects, useThreadShells } from "../../state/entities";
import { linkedPullRequestDetailAtom } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { reportCommandResult } from "../botsSettingsShared";
import { parsePullRequestUrl } from "./kanbanIssue.logic";

const STATUS_DOT: Record<ThreadCardStatus, string> = {
  approval: "bg-amber-500 dark:bg-amber-300/90",
  input: "bg-indigo-500 dark:bg-indigo-300/90",
  failed: "bg-red-500 dark:bg-red-400/90",
  working: "bg-sky-500 dark:bg-sky-300/90",
  settled: "bg-emerald-500 dark:bg-emerald-400/80",
};

type PullRequestTarget = NonNullable<
  ReturnType<typeof resolveChangeRequestLinkTarget<EnvironmentProject>>
>;

/** A ticket's pull requests and threads, and the actions that start or link work. */
export function KanbanIssueLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
  readonly snapshot: KanbanSnapshot;
  readonly canEdit: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, ticket } = props;
  return (
    <div className="flex flex-col gap-6">
      {ticket.pullRequests.length > 0 ? (
        <LinkSection title="Pull requests">
          <PullRequestRows environmentId={environmentId} ticket={ticket} />
        </LinkSection>
      ) : null}
      <ThreadLinks {...props} />
    </div>
  );
}

function LinkSection(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-0.5">
      <div className="mb-1.5 flex min-h-6 items-center gap-2 px-2">
        <h3 className="flex-1 font-medium text-muted-foreground text-xs">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function PullRequestRows(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
}) {
  const projects = useProjects();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const capabilities = config?.environment.capabilities;
  return (
    <ul className="flex flex-col">
      {props.ticket.pullRequests.map((pullRequest) => {
        const target =
          capabilities === undefined
            ? null
            : resolveChangeRequestLinkTarget({
                url: pullRequest.url,
                projects,
                capabilities: (environmentId) =>
                  environmentId === props.environmentId ? capabilities : undefined,
                environmentId: props.environmentId,
                projectId: props.ticket.projectId,
                lendHostProject: false,
              });
        return (
          <li key={pullRequest.attachmentId}>
            <PullRequestRow pullRequest={pullRequest} target={target} />
          </li>
        );
      })}
    </ul>
  );
}

function PullRequestRow(props: {
  readonly pullRequest: KanbanPullRequestRef;
  readonly target: PullRequestTarget | null;
}) {
  const { pullRequest, target } = props;
  const navigate = useNavigate();
  const parsed = parsePullRequestUrl(pullRequest.url);
  const repository = pullRequest.repository || parsed?.repository || "";
  const number = pullRequest.number > 0 ? pullRequest.number : (parsed?.number ?? 0);
  const { data: summary } = useEnvironmentQuery(
    target === null
      ? null
      : linkedPullRequestDetailAtom({
          environmentId: target.project.environmentId,
          input: {
            projectId: target.project.id,
            repository: target.repository,
            number: target.number,
            ...(target.host === undefined ? {} : { host: target.host }),
          },
        }),
  );
  const state = summary?.state ?? (pullRequest.state === "draft" ? "open" : pullRequest.state);
  const isDraft = summary?.isDraft ?? pullRequest.state === "draft";
  const checks =
    summary?.checksState == null ? null : pullRequestChecksStatePresentation(summary.checksState);

  const open = () => {
    if (target === null) {
      window.open(pullRequest.url, "_blank", "noopener");
      return;
    }
    void navigate({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        repository: target.repository,
        number: target.number,
        selectedHost: target.host ?? "github.com",
        selectedProjectId: target.project.id,
        selectedEnvironmentId: target.project.environmentId,
      },
    });
  };

  return (
    <button
      type="button"
      className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
      onClick={open}
    >
      <PullRequestStateGlyph state={state} isDraft={isDraft} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">#{number}</span>{" "}
        {summary?.title ?? pullRequest.title}
        <span className="ml-1.5 text-muted-foreground text-xs">{repository}</span>
      </span>
      {checks ? (
        <checks.Icon
          role="img"
          aria-label={checks.label}
          className={cn("size-3.5 shrink-0", checks.toneClassName)}
        />
      ) : null}
      {summary?.additions !== undefined && summary.deletions !== undefined ? (
        <PullRequestDiffStat
          additions={summary.additions}
          deletions={summary.deletions}
          className="shrink-0 text-xs"
        />
      ) : null}
    </button>
  );
}

function ThreadLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
  readonly snapshot: KanbanSnapshot;
  readonly canEdit: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, ticket, snapshot } = props;
  const shells = useThreadShells();
  const { directory } = useBotDirectory(environmentId);
  const link = useAtomCommand(botsEnvironment.kanbanLinkThread, { label: "kanban link" });
  const unlink = useAtomCommand(botsEnvironment.kanbanUnlinkThread, { label: "kanban unlink" });
  const start = useAtomCommand(botsEnvironment.kanbanStartThread, { label: "kanban start" });
  const [starting, setStarting] = useState(false);

  const environmentShells = shells.filter(
    (shell) => shell.environmentId === environmentId && shell.archivedAt === null,
  );
  const shellsById = new Map(environmentShells.map((shell) => [shell.id, shell]));
  // Threads deleted since they were linked are not shown.
  const linked = ticket.threadIds.flatMap((threadId) => shellsById.get(threadId) ?? []);
  const linkable = environmentShells
    .filter(
      (shell) =>
        shell.projectId === ticket.projectId &&
        !ticket.threadIds.includes(shell.id) &&
        !shell.id.startsWith("bot:"),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 30);

  const botsById = new Map((directory?.bots ?? []).map((bot) => [bot.id, bot]));
  const workspace = snapshot.workspaces.find(
    (candidate) => candidate.id === workspaceOf(snapshot, ticket),
  );
  const askable = [
    ...new Set([...(ticket.botId ? [ticket.botId] : []), ...(workspace?.botIds ?? [])]),
  ].flatMap((botId) => botsById.get(botId) ?? []);

  const startThread = async (
    target: { kind: "project" } | { kind: "bot"; bot: BotDirectoryEntry },
  ) => {
    setStarting(true);
    const result = await start({
      environmentId,
      input: {
        ticketId: ticket.id,
        target:
          target.kind === "project" ? { kind: "project" } : { kind: "bot", botId: target.bot.id },
      },
    });
    setStarting(false);
    if (reportCommandResult("Could not start a thread", result) && result._tag === "Success") {
      props.onOpenThread(result.value.threadId);
    }
  };

  return (
    <LinkSection
      title="Threads"
      action={
        props.canEdit ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Link thread"
                  disabled={linkable.length === 0}
                />
              }
            >
              <LinkIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="max-h-80">
              <MenuGroup>
                <MenuGroupLabel>Threads of this project</MenuGroupLabel>
                {linkable.map((thread) => (
                  <MenuItem
                    key={thread.id}
                    onClick={async () =>
                      reportCommandResult(
                        "Could not link the thread",
                        await link({
                          environmentId,
                          input: { ticketId: ticket.id, threadId: thread.id },
                        }),
                      )
                    }
                  >
                    <span className="max-w-72 truncate">{thread.title}</span>
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        ) : null
      }
    >
      {linked.length > 0 ? (
        <ul className="flex flex-col">
          {linked.map((thread) => {
            const status = threadCardStatus(thread);
            return (
              <li key={thread.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                  onClick={() => props.onOpenThread(thread.id)}
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />
                  <span className="truncate">{thread.title}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                    {THREAD_CARD_STATUS_LABELS[status]}
                  </span>
                </button>
                {props.canEdit ? (
                  <Button
                    size="icon-tiny"
                    variant="ghost-muted"
                    aria-label={`Unlink ${thread.title}`}
                    onClick={async () =>
                      reportCommandResult(
                        "Could not unlink the thread",
                        await unlink({
                          environmentId,
                          input: { ticketId: ticket.id, threadId: thread.id },
                        }),
                      )
                    }
                  >
                    <XIcon />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-2 text-muted-foreground text-xs">No threads yet.</p>
      )}
      {props.canEdit ? (
        <div className="mt-2 px-2">
          <Group>
            <Button
              size="sm"
              disabled={starting}
              onClick={() => void startThread({ kind: "project" })}
            >
              <PlayIcon />
              {starting ? "Starting…" : "Start thread"}
            </Button>
            {askable.length > 0 ? (
              <>
                <GroupSeparator />
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="icon-sm" disabled={starting} aria-label="Ask a bot instead" />
                    }
                  >
                    <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    {askable.map((bot) => (
                      <MenuItem key={bot.id} onClick={() => void startThread({ kind: "bot", bot })}>
                        <BotAvatar botId={bot.id} size={16} />
                        Ask {bot.name}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </>
            ) : null}
          </Group>
        </div>
      ) : null}
    </LinkSection>
  );
}
