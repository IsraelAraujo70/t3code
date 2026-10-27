import {
  KANBAN_PRIORITY_LABELS,
  type ThreadCardStatus,
} from "@t3tools/client-runtime/kanban-board";
import type {
  BotDirectoryEntry,
  KanbanDisplayProperty,
  KanbanTicket,
  ThreadId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { pullRequestStatus } from "../../features/pull-requests/pullRequestStatus";
import {
  dueDateOf,
  formatKanbanDate,
  isOverdue,
  personDisplay,
  pullRequestBadge,
  statusDisplay,
  type KanbanLookups,
} from "./kanbanDisplay.logic";
import {
  KanbanAvatar,
  KanbanBotFaces,
  KanbanDot,
  KanbanLabelPill,
  KanbanPill,
  KanbanPillText,
  KanbanPriorityIcon,
  KanbanStatusIcon,
  KanbanThreadDot,
  type KanbanGlyphColors,
} from "./KanbanGlyphs";

export interface KanbanCardThread {
  readonly id: ThreadId;
  readonly status: ThreadCardStatus;
}

const MAX_LABELS = 3;

/** One ticket, Linear-dense: identifier and parent, status and title, property chips, dates. */
export const KanbanCard = memo(function KanbanCard(props: {
  readonly ticket: KanbanTicket;
  readonly lookups: KanbanLookups;
  readonly colors: KanbanGlyphColors;
  readonly properties: ReadonlySet<KanbanDisplayProperty>;
  /** The ticket's own bot, else its workspace's bots. */
  readonly bots: ReadonlyArray<BotDirectoryEntry>;
  readonly threads: ReadonlyArray<KanbanCardThread>;
  /** The T3 project, on the board of every project; null on one project's board. */
  readonly projectTitle: string | null;
  readonly now: Date;
  readonly actions: MenuAction[];
  readonly onChoice: (ticket: KanbanTicket, id: string) => void;
  readonly onOpen: (ticket: KanbanTicket) => void;
}) {
  const { ticket, lookups, colors, properties: show, now } = props;
  const status = statusDisplay(lookups, ticket.status);
  const assignee =
    ticket.assigneeId === null
      ? null
      : personDisplay(lookups, ticket.assigneeId, ticket.assigneeName);
  const labels = show.has("labels")
    ? ticket.labelIds.flatMap((id) => {
        const label = lookups.labelsById.get(id);
        return label === undefined ? [] : [label];
      })
    : [];
  const linearProject =
    ticket.linearProjectId === null ? undefined : lookups.projectsById.get(ticket.linearProjectId);
  const cycle = ticket.cycleId === null ? undefined : lookups.cyclesById.get(ticket.cycleId);
  const milestone =
    ticket.milestoneId === null ? undefined : lookups.milestonesById.get(ticket.milestoneId);
  const pullRequests = show.has("pullRequests") ? pullRequestBadge(ticket.pullRequests) : null;
  const overdue = isOverdue(ticket, now);

  const chips: ReactNode[] = [];
  if (show.has("priority") && ticket.priority > 0) {
    chips.push(
      <View
        key="priority"
        accessibilityLabel={KANBAN_PRIORITY_LABELS[ticket.priority]}
        className="size-5 items-center justify-center rounded-md border border-border"
      >
        <KanbanPriorityIcon priority={ticket.priority} colors={colors} size={12} />
      </View>,
    );
  }
  if (show.has("project") && linearProject !== undefined) {
    chips.push(
      <KanbanPill key="linear-project">
        <KanbanDot color={linearProject.color} />
        <KanbanPillText>{linearProject.name}</KanbanPillText>
      </KanbanPill>,
    );
  }
  if (show.has("project") && props.projectTitle !== null) {
    chips.push(
      <KanbanPill key="project">
        <SymbolView name="folder" size={11} tintColorClassName="accent-icon-muted" />
        <KanbanPillText>{props.projectTitle}</KanbanPillText>
      </KanbanPill>,
    );
  }
  for (const label of labels.slice(0, MAX_LABELS)) {
    chips.push(<KanbanLabelPill key={`label:${label.id}`} label={label} />);
  }
  if (labels.length > MAX_LABELS) {
    chips.push(
      <KanbanPill key="labels-more">
        <KanbanPillText>{`+${labels.length - MAX_LABELS}`}</KanbanPillText>
      </KanbanPill>,
    );
  }
  if (show.has("subIssues") && ticket.subIssues !== null && ticket.subIssues.total > 0) {
    const { closed, total } = ticket.subIssues;
    chips.push(
      <KanbanPill key="sub-issues">
        <KanbanStatusIcon
          stateType={closed >= total ? "completed" : "started"}
          color={colors.muted}
          progress={closed / total}
          size={11}
        />
        <KanbanPillText>{`${closed}/${total}`}</KanbanPillText>
      </KanbanPill>,
    );
  }
  if (pullRequests !== null) {
    const presentation = pullRequestStatus({
      state: pullRequests.state === "draft" ? "open" : pullRequests.state,
      isDraft: pullRequests.state === "draft",
    });
    chips.push(
      <KanbanPill key="pull-requests">
        <SymbolView name={presentation.icon} size={11} tintColorClassName={presentation.tint} />
        <Text className={`text-2xs ${presentation.text}`}>{pullRequests.text}</Text>
      </KanbanPill>,
    );
  }
  if (show.has("dueDate") && ticket.dueDate !== null) {
    const tone = overdue ? "danger" : "default";
    chips.push(
      <KanbanPill key="due" tone={tone}>
        <SymbolView
          name="calendar.badge.clock"
          size={11}
          tintColorClassName={overdue ? "accent-danger-foreground" : "accent-icon-muted"}
        />
        <KanbanPillText tone={tone}>
          {formatKanbanDate(dueDateOf(ticket.dueDate), now)}
        </KanbanPillText>
      </KanbanPill>,
    );
  }
  if (show.has("cycle") && cycle !== undefined) {
    chips.push(
      <KanbanPill key="cycle">
        <KanbanPillText>{cycle.name ?? `Cycle ${cycle.number}`}</KanbanPillText>
      </KanbanPill>,
    );
  }
  if (show.has("milestone") && milestone !== undefined) {
    chips.push(
      <KanbanPill key="milestone">
        <KanbanPillText>{milestone.name}</KanbanPillText>
      </KanbanPill>,
    );
  }
  if (show.has("estimate") && ticket.estimate !== null) {
    chips.push(
      <KanbanPill key="estimate">
        <KanbanPillText>{`${ticket.estimate} pts`}</KanbanPillText>
      </KanbanPill>,
    );
  }

  const dates = [
    show.has("created") ? `Created ${formatKanbanDate(new Date(ticket.createdAt), now)}` : null,
    show.has("updated") ? `Updated ${formatKanbanDate(new Date(ticket.updatedAt), now)}` : null,
  ].filter((part) => part !== null);
  const bots = show.has("bot") ? props.bots : [];
  const threads = show.has("threads") ? props.threads : [];
  const showHeader = show.has("id") || ticket.parent !== null || show.has("assignee");

  return (
    <Menu
      shouldOpenOnLongPress
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onChoice(ticket, nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ticket.identifier}, ${ticket.title}, ${status.name}`}
        accessibilityHint="Opens the issue. Long-press for move and link actions."
        onPress={() => props.onOpen(ticket)}
        className="rounded-xl border border-border bg-card px-3 py-2.5 active:bg-subtle"
      >
        {showHeader ? (
          <View className="h-5 flex-row items-center gap-1">
            {show.has("id") ? (
              <Text className="shrink-0 text-xs text-foreground-muted">{ticket.identifier}</Text>
            ) : null}
            {ticket.parent !== null ? (
              <>
                {show.has("id") ? (
                  <SymbolView
                    name="chevron.right"
                    size={10}
                    tintColorClassName="accent-icon-muted"
                  />
                ) : null}
                <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
                  {`${ticket.parent.identifier} ${ticket.parent.title}`}
                </Text>
              </>
            ) : null}
            {show.has("assignee") ? (
              <View
                className="ml-auto shrink-0 pl-2"
                accessibilityLabel={
                  assignee === null ? "Unassigned" : `Assigned to ${assignee.name}`
                }
              >
                <KanbanAvatar person={assignee} colors={colors} size={18} />
              </View>
            ) : null}
          </View>
        ) : null}

        <View className="mt-1 flex-row items-start gap-1.5">
          {show.has("status") ? (
            <View className="mt-0.5 shrink-0">
              <KanbanStatusIcon
                stateType={status.stateType}
                color={status.color}
                progress={status.progress}
              />
            </View>
          ) : null}
          <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={2}>
            {ticket.title}
          </Text>
        </View>

        {chips.length > 0 ? <View className="mt-2 flex-row flex-wrap gap-1">{chips}</View> : null}

        {dates.length > 0 || bots.length > 0 || threads.length > 0 ? (
          <View className="mt-2 h-5 flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-2xs text-foreground-muted" numberOfLines={1}>
              {dates.join(" · ")}
            </Text>
            <KanbanBotFaces bots={bots} />
            {threads.length > 0 ? (
              <View
                className="flex-row items-center gap-1"
                accessibilityLabel={`${threads.length} linked ${threads.length === 1 ? "thread" : "threads"}`}
              >
                <SymbolView
                  name="bubble.left.and.bubble.right"
                  size={11}
                  tintColorClassName="accent-icon-muted"
                />
                <Text className="text-2xs text-foreground-muted">{threads.length}</Text>
                <View className="flex-row items-center gap-0.5">
                  {threads.slice(0, 5).map((thread) => (
                    <KanbanThreadDot key={thread.id} status={thread.status} />
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </Menu>
  );
});
