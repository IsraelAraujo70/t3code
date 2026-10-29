import { useAtomValue } from "@effect/atom-react";
import {
  KANBAN_PRIORITY_LABELS,
  kanbanStartProjectTarget,
  THREAD_CARD_STATUS_LABELS,
  threadCardStatus,
} from "@t3tools/client-runtime/kanban-board";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  isCalendarDay,
  KanbanTicketId,
  type BotDirectoryEntry,
  type KanbanComment,
  type KanbanPullRequestRef,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketDetail,
  type KanbanTicketPatch,
  type ThreadId,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { pullRequestStatus } from "../../features/pull-requests/pullRequestStatus";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useNavigateToPullRequest } from "../../native/useOpenPullRequest";
import { useProject, useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useKanbanGlyphColors } from "../BotsKanbanRouteScreen";
import { BotAvatar } from "../BotAvatar";
import { botsEnvironment, useBotDirectory, useKanbanSnapshot } from "../state";
import type { ThreadReturnTab } from "../threadReturnTab";
import {
  buildKanbanLookups,
  dateFromIsoDay,
  dueDatePresets,
  formatDueDate,
  formatKanbanDate,
  isoDay,
  isOverdue,
  personDisplay,
  statusDisplay,
  type KanbanLookups,
} from "@t3tools/client-runtime/kanban-display";
import {
  KanbanAvatar,
  KanbanDot,
  KanbanPriorityIcon,
  KanbanStatusIcon,
  KanbanThreadDot,
  type KanbanGlyphColors,
} from "./KanbanGlyphs";
import {
  assigneeChoices,
  issueTimeline,
  labelChoices,
  responsibleBotIds,
  statusChoices,
} from "@t3tools/client-runtime/kanban-display";
import {
  addPendingWrite,
  draftedLabelIds,
  reconcileLabelDraft,
  removePendingWrite,
  toggleDraftLabel,
  type KanbanLabelDraft,
  type PendingWrites,
} from "./kanbanIssue.logic";
import { KanbanPickerSheet, reportKanbanResult } from "./KanbanPickerSheet";

type KanbanIssueScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly ticketId: string;
  /** Set when opened from the Kanban tab, so a thread opened here returns to it. */
  readonly returnTab?: ThreadReturnTab;
}>;

type IssueSheet = "status" | "priority" | "assignee" | "labels" | "due" | "bot" | "link";

const NONE = "none";

/** A Linear issue (or local ticket) on a phone: properties, description, work and discussion. */
export function KanbanIssueScreen({ route }: KanbanIssueScreenProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const ticketId = KanbanTicketId.make(route.params.ticketId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { snapshot, error } = useKanbanSnapshot(environmentId);
  const ticket = snapshot?.tickets.find((candidate) => candidate.id === ticketId) ?? null;
  const onBack = useCallback(() => navigation.goBack(), [navigation]);
  const linearUrl = ticket?.linear?.url ?? null;

  return (
    <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
      <AppBar
        title={ticket?.identifier ?? "Issue"}
        sidebar={false}
        onBack={onBack}
        options={{ headerBackVisible: false }}
        actions={
          linearUrl === null
            ? []
            : [
                {
                  accessibilityLabel: "Open in Linear",
                  icon: "arrow.up.right" as const,
                  onPress: () => void Linking.openURL(linearUrl),
                },
              ]
        }
      />
      {error !== null ? (
        <View className="px-4 py-3">
          <Notice tone="danger" message={`Kanban unavailable: ${error}`} />
        </View>
      ) : snapshot === null ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">Loading the issue…</Text>
      ) : ticket === null ? (
        <View className="px-4 py-3">
          <Notice icon="info.circle" message="This ticket is no longer on the board." />
        </View>
      ) : (
        <IssueBody
          environmentId={environmentId}
          snapshot={snapshot}
          ticket={ticket}
          returnTab={route.params.returnTab}
        />
      )}
    </View>
  );
}

function useTicketDetail(environmentId: EnvironmentId, ticketId: KanbanTicketId) {
  const fetchDetail = useAtomCommand(botsEnvironment.kanbanTicketDetail, {
    label: "kanban ticket detail",
    reportFailure: false,
  });
  const key = `${environmentId}\u0000${ticketId}`;
  const [read, setRead] = useState<{
    readonly key: string;
    readonly detail: KanbanTicketDetail | null;
    readonly error: string | null;
  }>({ key, detail: null, error: null });
  // Only the newest read still running applies; unmount or a new ticket bumps it too.
  const generation = useRef(0);
  // A re-read after a write keeps showing the issue it had until the answer arrives.
  const refresh = useCallback(async () => {
    const own = ++generation.current;
    const result = await fetchDetail({ environmentId, input: { ticketId } });
    if (own !== generation.current) return;
    if (result._tag === "Success") {
      setRead({ key, detail: result.value, error: null });
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      const error = failure instanceof Error ? failure.message : String(failure);
      setRead((previous) => ({
        key,
        detail: previous.key === key ? previous.detail : null,
        error,
      }));
    }
  }, [fetchDetail, environmentId, ticketId, key]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the issue from the server (Linear) when it opens
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the read's answer arrives after an await, never synchronously
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  const detail = read.key === key ? read.detail : null;
  const error = read.key === key ? read.error : null;
  return { detail, error, loading: detail === null && error === null, refresh };
}

function IssueBody(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KanbanSnapshot;
  readonly ticket: KanbanTicket;
  readonly returnTab: ThreadReturnTab | undefined;
}) {
  const { environmentId, snapshot, ticket, returnTab } = props;
  const navigation = useNavigation();
  const colors = useKanbanGlyphColors();
  const markdownStyles = useMarkdownPreviewStyles();
  const navigateToPullRequest = useNavigateToPullRequest();
  const { directory } = useBotDirectory(environmentId);
  const shells = useThreadShells();
  const project = useProject({ environmentId, projectId: ticket.projectId });
  const bots = directory?.bots;
  const lookups = useMemo(() => buildKanbanLookups(snapshot, bots ?? []), [snapshot, bots]);
  const {
    detail,
    error: detailError,
    loading,
    refresh,
  } = useTicketDetail(environmentId, ticket.id);
  const update = useAtomCommand(botsEnvironment.kanbanUpdateTicket, { label: "kanban update" });
  const move = useAtomCommand(botsEnvironment.kanbanMoveTicket, { label: "kanban move" });
  const comment = useAtomCommand(botsEnvironment.kanbanComment, { label: "kanban comment" });
  const deleteComment = useAtomCommand(botsEnvironment.kanbanDeleteComment, {
    label: "kanban delete comment",
  });
  const startThread = useAtomCommand(botsEnvironment.kanbanStartThread, {
    label: "kanban start thread",
  });
  const link = useAtomCommand(botsEnvironment.kanbanLinkThread, { label: "kanban link" });
  const unlink = useAtomCommand(botsEnvironment.kanbanUnlinkThread, { label: "kanban unlink" });
  const canEdit = useAtomValue(botsEnvironment.kanbanUpdateTicket.permissionAtom(environmentId));
  const [sheet, setSheet] = useState<IssueSheet | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingWrites>(() => new Map());
  const anyPending = pending.size > 0;
  const commentInFlight = useRef(false);
  const [storedLabelDraft, setLabelDraft] = useState<KanbanLabelDraft | null>(null);
  const labelDraft = reconcileLabelDraft(storedLabelDraft, ticket);
  if (labelDraft !== storedLabelDraft) setLabelDraft(labelDraft);
  const labelIds = draftedLabelIds(labelDraft, ticket);

  const [now] = useState(() => new Date());
  const status = statusDisplay(lookups, ticket.status);
  const assignee =
    ticket.assigneeId === null
      ? null
      : personDisplay(lookups, ticket.assigneeId, ticket.assigneeName);
  const labels = labelIds.flatMap((id) => {
    const label = lookups.labelsById.get(id);
    return label === undefined ? [] : [label];
  });
  const ownBot = ticket.botId === null ? null : (lookups.botsById.get(ticket.botId) ?? null);
  const responsible = responsibleBotIds(snapshot, ticket).flatMap((botId) => {
    const bot = lookups.botsById.get(botId);
    return bot === undefined ? [] : [bot];
  });
  const threadsById = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId && shell.archivedAt === null)
      .map((shell) => [shell.id, shell]),
  );
  const linkedThreads = ticket.threadIds.flatMap((id) => {
    const shell = threadsById.get(id);
    return shell === undefined ? [] : [shell];
  });
  const linkableThreads = [...threadsById.values()]
    .filter(
      (shell) =>
        shell.projectId === ticket.projectId &&
        !ticket.threadIds.includes(shell.id) &&
        !shell.id.startsWith("bot:"),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 30);
  const timeline = detail === null ? [] : issueTimeline(detail);

  const track = async <A,>(key: string, run: () => Promise<A>): Promise<A> => {
    setPending((current) => addPendingWrite(current, key));
    try {
      return await run();
    } finally {
      setPending((current) => removePendingWrite(current, key));
    }
  };
  /** Runs one write, reports a failure, and re-reads the issue after it. */
  const write = async (
    key: string,
    title: string,
    run: () => Promise<Parameters<typeof reportKanbanResult>[1]>,
  ): Promise<boolean> => {
    const ok = reportKanbanResult(title, await track(key, run));
    if (ok) void refresh();
    return ok;
  };
  const patch = (key: string, value: KanbanTicketPatch) =>
    write(key, `Could not update ${ticket.identifier}`, () =>
      update({ environmentId, input: { ticketId: ticket.id, patch: value } }),
    );

  const openThread = (threadId: ThreadId) =>
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId,
        threadId,
        ...(returnTab === undefined ? {} : { returnTab }),
      }),
    );
  const openTicket = (ticketId: KanbanTicketId) =>
    navigation.dispatch(
      StackActions.push("BotsKanbanIssue", {
        environmentId,
        ticketId,
        ...(returnTab === undefined ? {} : { returnTab }),
      }),
    );
  const openPullRequest = (pullRequest: KanbanPullRequestRef) =>
    void navigateToPullRequest(pullRequest.url, { environmentId, projectId: ticket.projectId });

  const start = async (
    target: { kind: "project" } | { kind: "bot"; botId: BotDirectoryEntry["id"] },
  ) => {
    const result = await track("start", () =>
      startThread({
        environmentId,
        input: {
          ticketId: ticket.id,
          target:
            target.kind === "project"
              ? kanbanStartProjectTarget(
                  project?.defaultModelSelection ?? null,
                  [...threadsById.values()],
                  ticket,
                )
              : target,
        },
      }),
    );
    if (!reportKanbanResult("Could not start a thread", result)) return;
    if (result._tag === "Success") {
      void refresh();
      openThread(result.value.threadId);
    }
  };

  const sendComment = async () => {
    const body = draft.trim();
    if (body.length === 0 || commentInFlight.current) return;
    commentInFlight.current = true;
    try {
      const sent = await write("comment", "Could not send the comment", () =>
        comment({ environmentId, input: { ticketId: ticket.id, body } }),
      );
      if (sent) setDraft("");
    } finally {
      commentInFlight.current = false;
    }
  };

  const confirmDeleteComment = (target: KanbanComment) =>
    Dialog.confirm({
      title: "Delete comment?",
      message: target.body.slice(0, 140),
      confirmText: "Delete",
      destructive: true,
      onConfirm: () =>
        void write(`delete:${target.id}`, "Could not delete the comment", () =>
          deleteComment({ environmentId, input: { ticketId: ticket.id, commentId: target.id } }),
        ),
    });

  const pickCustomDue = () =>
    Dialog.prompt({
      title: "Due date",
      message: "YYYY-MM-DD",
      placeholder: isoDay(now),
      initialValue: ticket.dueDate ?? "",
      confirmText: "Set",
      onConfirm: (value) => {
        const day = value.trim();
        if (isCalendarDay(day)) void patch("due", { dueDate: day });
        else Dialog.alert("Not a date", "Write the date as YYYY-MM-DD.");
      },
    });

  const description = detail?.description ?? null;
  const parent = detail?.parent ?? ticket.parent;
  const parentTicketId = detail?.parent?.ticketId ?? null;

  return (
    <>
      <ScrollView
        contentContainerClassName="gap-5 px-4 pt-2 pb-16"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View className="gap-2">
          {parent !== null ? (
            <Pressable
              accessibilityRole={parentTicketId === null ? "text" : "link"}
              disabled={parentTicketId === null}
              onPress={() => parentTicketId !== null && openTicket(parentTicketId)}
              className="flex-row items-center gap-1"
            >
              <Text className="text-xs text-foreground-muted">Sub-issue of</Text>
              <Text className="min-w-0 shrink text-xs text-foreground" numberOfLines={1}>
                {`${parent.identifier} ${parent.title}`}
              </Text>
            </Pressable>
          ) : null}
          <Text className="font-t3-medium text-xl text-foreground">{ticket.title}</Text>
          <Text className="text-xs text-foreground-muted">
            {`${ticket.identifier} · Created ${formatKanbanDate(new Date(ticket.createdAt), now)} · Updated ${formatKanbanDate(new Date(ticket.updatedAt), now)}`}
          </Text>
        </View>

        <ListSection title="Properties">
          <PropertyRow
            label="Status"
            disabled={!canEdit}
            busy={pending.has("status")}
            onPress={() => setSheet("status")}
          >
            <KanbanStatusIcon
              stateType={status.stateType}
              color={status.color}
              progress={status.progress}
            />
            <PropertyValue>{status.name}</PropertyValue>
          </PropertyRow>
          <PropertyRow
            label="Priority"
            disabled={!canEdit}
            busy={pending.has("priority")}
            onPress={() => setSheet("priority")}
          >
            <KanbanPriorityIcon priority={ticket.priority} colors={colors} />
            <PropertyValue>
              {KANBAN_PRIORITY_LABELS[ticket.priority] ?? "No priority"}
            </PropertyValue>
          </PropertyRow>
          <PropertyRow
            label="Assignee"
            disabled={!canEdit}
            busy={pending.has("assignee")}
            onPress={() => setSheet("assignee")}
          >
            <KanbanAvatar person={assignee} colors={colors} size={18} />
            <PropertyValue>{assignee?.name ?? "Unassigned"}</PropertyValue>
          </PropertyRow>
          <PropertyRow
            label="Labels"
            disabled={!canEdit}
            busy={pending.has("labels")}
            onPress={() => setSheet("labels")}
          >
            {labels.length === 0 ? (
              <PropertyValue muted>No labels</PropertyValue>
            ) : (
              <View className="min-w-0 shrink flex-row flex-wrap justify-end gap-1">
                {labels.map((label) => (
                  <View key={label.id} className="flex-row items-center gap-1">
                    <KanbanDot color={label.color} />
                    <Text className="text-sm text-foreground">{label.name}</Text>
                  </View>
                ))}
              </View>
            )}
          </PropertyRow>
          <PropertyRow
            label="Due date"
            disabled={!canEdit}
            busy={pending.has("due")}
            onPress={() => setSheet("due")}
          >
            <PropertyValue muted={ticket.dueDate === null} danger={isOverdue(ticket, now)}>
              {ticket.dueDate === null
                ? "No due date"
                : formatDueDate(ticket.dueDate, (date) => formatKanbanDate(date, now))}
            </PropertyValue>
          </PropertyRow>
          <PropertyRow
            label="Bot"
            disabled={!canEdit}
            busy={pending.has("bot")}
            onPress={() => setSheet("bot")}
            last
          >
            {ownBot !== null ? <BotAvatar botId={ownBot.id} size={18} /> : null}
            <PropertyValue muted={ownBot === null}>
              {ownBot?.name ??
                (responsible.length > 0
                  ? `Workspace: ${responsible.map((bot) => bot.name).join(", ")}`
                  : "None")}
            </PropertyValue>
          </PropertyRow>
        </ListSection>

        <View className="gap-2">
          <SectionTitle>Description</SectionTitle>
          {detail === null && loading ? (
            <Text className="text-sm text-foreground-muted">Loading…</Text>
          ) : description === null || description.trim() === "" ? (
            <Text className="text-sm text-foreground-muted">No description.</Text>
          ) : (
            <SelectableMarkdownText
              markdown={description}
              textStyle={markdownStyles.nativeTextStyle}
              onLinkPress={(href) => void Linking.openURL(href)}
            />
          )}
          {detailError !== null ? (
            <Notice tone="danger" message={`Could not load the issue: ${detailError}`} />
          ) : null}
        </View>

        {detail !== null && detail.children.length > 0 ? (
          <ListSection
            title={`Sub-issues ${detail.children.filter((child) => statusDisplay(lookups, child.status).stateType === "completed").length}/${detail.children.length}`}
          >
            {detail.children.map((child, index) => {
              const childStatus = statusDisplay(lookups, child.status);
              const childTicketId = child.ticketId;
              const url = child.url;
              return (
                <RowButton
                  key={child.issueId}
                  last={index === detail.children.length - 1}
                  accessibilityLabel={`${child.identifier}, ${child.title}, ${childStatus.name}`}
                  disabled={childTicketId === null && url === null}
                  onPress={() =>
                    childTicketId !== null
                      ? openTicket(childTicketId)
                      : url !== null
                        ? void Linking.openURL(url)
                        : undefined
                  }
                >
                  <KanbanStatusIcon
                    stateType={childStatus.stateType}
                    color={childStatus.color}
                    progress={childStatus.progress}
                  />
                  <Text className="shrink-0 text-xs text-foreground-muted">{child.identifier}</Text>
                  <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                    {child.title}
                  </Text>
                  {child.assigneeId !== null ? (
                    <KanbanAvatar
                      person={personDisplay(lookups, child.assigneeId)}
                      colors={colors}
                      size={16}
                    />
                  ) : null}
                </RowButton>
              );
            })}
          </ListSection>
        ) : null}

        {ticket.pullRequests.length > 0 ? (
          <ListSection title="Pull requests">
            {ticket.pullRequests.map((pullRequest, index) => {
              const presentation = pullRequestStatus({
                state: pullRequest.state === "draft" ? "open" : pullRequest.state,
                isDraft: pullRequest.state === "draft",
              });
              return (
                <RowButton
                  key={pullRequest.attachmentId}
                  last={index === ticket.pullRequests.length - 1}
                  accessibilityLabel={`${pullRequest.repository} #${pullRequest.number}, ${pullRequest.title}, ${presentation.label}`}
                  onPress={() => openPullRequest(pullRequest)}
                >
                  <SymbolView
                    name={presentation.icon}
                    size={16}
                    tintColorClassName={presentation.tint}
                  />
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm text-foreground" numberOfLines={1}>
                      {pullRequest.title}
                    </Text>
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {`${pullRequest.repository}#${pullRequest.number} · ${presentation.label}`}
                    </Text>
                  </View>
                </RowButton>
              );
            })}
          </ListSection>
        ) : null}

        <View className="gap-2">
          <SectionTitle>Threads</SectionTitle>
          {linkedThreads.length > 0 ? (
            <ListSection>
              {linkedThreads.map((thread, index) => {
                const threadStatus = threadCardStatus(thread);
                return (
                  <RowButton
                    key={thread.id}
                    last={index === linkedThreads.length - 1}
                    accessibilityLabel={`${thread.title}, ${THREAD_CARD_STATUS_LABELS[threadStatus]}`}
                    onPress={() => openThread(thread.id)}
                    trailing={
                      canEdit ? (
                        <ControlPill
                          icon="xmark"
                          accessibilityLabel={`Unlink ${thread.title}`}
                          disabled={anyPending}
                          onPress={() =>
                            void write(`unlink:${thread.id}`, "Could not unlink the thread", () =>
                              unlink({
                                environmentId,
                                input: { ticketId: ticket.id, threadId: thread.id },
                              }),
                            )
                          }
                        />
                      ) : null
                    }
                  >
                    <KanbanThreadDot status={threadStatus} />
                    <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                      {thread.title}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {THREAD_CARD_STATUS_LABELS[threadStatus]}
                    </Text>
                  </RowButton>
                );
              })}
            </ListSection>
          ) : (
            <Text className="text-sm text-foreground-muted">No linked threads.</Text>
          )}
          {canEdit ? (
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                variant="pill"
                icon="plus.bubble"
                label="Start thread"
                disabled={anyPending}
                onPress={() => void start({ kind: "project" })}
              />
              {responsible.map((bot) => (
                <ControlPill
                  key={bot.id}
                  variant="pill"
                  iconNode={<BotAvatar botId={bot.id} size={16} />}
                  label={`Ask ${bot.name}`}
                  disabled={anyPending}
                  onPress={() => void start({ kind: "bot", botId: bot.id })}
                />
              ))}
              {linkableThreads.length > 0 ? (
                <ControlPill
                  variant="pill"
                  icon="link"
                  label="Link thread"
                  disabled={anyPending}
                  onPress={() => setSheet("link")}
                />
              ) : null}
            </View>
          ) : null}
        </View>

        <View className="gap-3">
          <SectionTitle>Activity</SectionTitle>
          {detail === null && loading ? (
            <Text className="text-sm text-foreground-muted">Loading…</Text>
          ) : timeline.length === 0 && detail !== null ? (
            <Text className="text-sm text-foreground-muted">No activity yet.</Text>
          ) : null}
          {timeline.map((entry) =>
            entry.kind === "activity" ? (
              <View key={`a:${entry.activity.id}`} className="flex-row items-start gap-2">
                <View className="pt-0.5">
                  <KanbanAvatar
                    person={
                      entry.activity.actorId === null
                        ? null
                        : personDisplay(lookups, entry.activity.actorId, entry.activity.actorName)
                    }
                    colors={colors}
                    size={16}
                  />
                </View>
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
                  {`${entry.activity.actorName} ${entry.activity.text} · ${formatKanbanDate(new Date(entry.activity.createdAt), now)}`}
                </Text>
              </View>
            ) : (
              <CommentCard
                key={`c:${entry.comment.id}`}
                comment={entry.comment}
                lookups={lookups}
                colors={colors}
                now={now}
                textStyle={markdownStyles.nativeTextStyle}
                deleting={pending.has(`delete:${entry.comment.id}`)}
                onDelete={canEdit && entry.comment.deletable ? confirmDeleteComment : null}
              />
            ),
          )}
          {canEdit ? (
            <View className="gap-2">
              <TextInput
                multiline
                editable={!pending.has("comment")}
                accessibilityLabel="Comment"
                placeholder="Leave a comment…"
                placeholderTextColorClassName="accent-foreground-muted"
                value={draft}
                onChangeText={setDraft}
                className="min-h-20 rounded-2xl bg-grouped-card p-3 text-base text-foreground"
                style={{ textAlignVertical: "top" }}
              />
              <View className="items-end">
                <ControlPill
                  variant="primary"
                  icon="arrow.up"
                  label="Send"
                  disabled={draft.trim().length === 0 || pending.has("comment")}
                  onPress={() => void sendComment()}
                />
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {sheet === "status" ? (
        <KanbanPickerSheet
          title="Status"
          options={statusChoices(snapshot, ticket).map((choice) => {
            const display = statusDisplay(lookups, choice);
            return {
              value: choice.kind === "local" ? choice.state : choice.stateId,
              label: display.name,
              leading: (
                <KanbanStatusIcon
                  stateType={display.stateType}
                  color={display.color}
                  progress={display.progress}
                  size={18}
                />
              ),
            };
          })}
          selected={[ticket.status.kind === "local" ? ticket.status.state : ticket.status.stateId]}
          onPick={(value) => {
            setSheet(null);
            const choice = statusChoices(snapshot, ticket).find(
              (candidate) =>
                (candidate.kind === "local" ? candidate.state : candidate.stateId) === value,
            );
            if (choice === undefined) return;
            void write("status", `Could not move ${ticket.identifier}`, () =>
              move({ environmentId, input: { ticketId: ticket.id, to: choice } }),
            );
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet === "priority" ? (
        <KanbanPickerSheet
          title="Priority"
          options={[0, 1, 2, 3, 4].map((priority) => ({
            value: String(priority),
            label: KANBAN_PRIORITY_LABELS[priority] ?? String(priority),
            leading: <KanbanPriorityIcon priority={priority} colors={colors} size={18} />,
          }))}
          selected={[String(ticket.priority)]}
          onPick={(value) => {
            setSheet(null);
            void patch("priority", { priority: Number(value) });
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet === "assignee" ? (
        <KanbanPickerSheet
          title="Assignee"
          options={[
            {
              value: NONE,
              label: "Unassigned",
              leading: <KanbanAvatar person={null} colors={colors} size={22} />,
            },
            ...assigneeChoices(snapshot, ticket, [...lookups.botsById.keys()]).map((personId) => {
              const person = personDisplay(lookups, personId);
              return {
                value: personId,
                label: person.name,
                leading: <KanbanAvatar person={person} colors={colors} size={22} />,
              };
            }),
          ]}
          selected={[ticket.assigneeId ?? NONE]}
          onPick={(value) => {
            setSheet(null);
            void patch("assignee", { assigneeId: value === NONE ? null : value });
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet === "labels" ? (
        <KanbanPickerSheet
          title="Labels"
          multi
          options={labelChoices(snapshot, ticket).map((label) => ({
            value: label.id,
            label: label.name,
            leading: <KanbanDot color={label.color} size={10} />,
          }))}
          emptyText={
            ticket.linear === null
              ? "No local labels yet. Create them in T3 Code on your computer."
              : "This team has no labels."
          }
          selected={labelIds}
          onPick={(value) => {
            const next = toggleDraftLabel(labelDraft, ticket, value);
            setLabelDraft(next);
            void patch("labels", { labelIds: draftedLabelIds(next, ticket) }).then((ok) => {
              if (!ok) setLabelDraft(null);
            });
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet === "due" ? (
        <KanbanPickerSheet
          title="Due date"
          options={[
            ...dueDatePresets(now).map((preset) => ({
              value: preset.value,
              label: preset.label,
              subtitle: formatKanbanDate(dateFromIsoDay(preset.value), now),
            })),
            { value: "custom", label: "Pick a date…" },
            ...(ticket.dueDate === null ? [] : [{ value: NONE, label: "Remove due date" }]),
          ]}
          selected={ticket.dueDate === null ? [] : [ticket.dueDate]}
          onPick={(value) => {
            setSheet(null);
            if (value === "custom") pickCustomDue();
            else void patch("due", { dueDate: value === NONE ? null : value });
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet === "bot" ? (
        <KanbanPickerSheet
          title="Bot"
          options={[
            {
              value: NONE,
              label: "Workspace bots",
              subtitle: "The bots responsible for the workspace",
            },
            ...[...lookups.botsById.values()].map((bot) => ({
              value: bot.id,
              label: bot.name,
              leading: <BotAvatar botId={bot.id} size={22} />,
            })),
          ]}
          selected={[ticket.botId ?? NONE]}
          footer="The ticket's own bot stays in T3; Linear never sees it."
          onPick={(value) => {
            setSheet(null);
            const bot = lookups.botsById.get(value);
            void patch("bot", { botId: bot === undefined ? null : bot.id });
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet === "link" ? (
        <KanbanPickerSheet
          title="Link thread"
          options={linkableThreads.map((thread) => ({
            value: thread.id,
            label: thread.title,
            subtitle: THREAD_CARD_STATUS_LABELS[threadCardStatus(thread)],
          }))}
          selected={[]}
          onPick={(value) => {
            setSheet(null);
            const thread = linkableThreads.find((candidate) => candidate.id === value);
            if (thread === undefined) return;
            void write("link", "Could not link the thread", () =>
              link({ environmentId, input: { ticketId: ticket.id, threadId: thread.id } }),
            );
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

function SectionTitle(props: { readonly children: string }) {
  return (
    <Text textRole="footnote" className="px-1 font-t3-medium text-foreground-muted">
      {props.children}
    </Text>
  );
}

function PropertyValue(props: {
  readonly children: ReactNode;
  readonly muted?: boolean;
  readonly danger?: boolean;
}) {
  return (
    <Text
      numberOfLines={1}
      className={
        props.danger
          ? "min-w-0 shrink text-sm text-danger-foreground"
          : props.muted
            ? "min-w-0 shrink text-sm text-foreground-muted"
            : "min-w-0 shrink text-sm text-foreground"
      }
    >
      {props.children}
    </Text>
  );
}

function PropertyRow(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly last?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Change ${props.label}`}
      accessibilityState={{ disabled: props.disabled, busy: props.busy }}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      className={`min-h-12 flex-row items-center gap-3 px-4 py-2.5 active:bg-subtle ${props.last ? "" : "border-b border-border-subtle"}`}
      style={{ opacity: props.busy ? 0.5 : 1 }}
    >
      <Text className="w-20 text-sm text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
        {props.children}
      </View>
    </Pressable>
  );
}

function RowButton(props: {
  readonly children: ReactNode;
  readonly accessibilityLabel: string;
  readonly last: boolean;
  readonly disabled?: boolean;
  readonly trailing?: ReactNode;
  readonly onPress: () => void;
}) {
  return (
    <View className={`flex-row items-center ${props.last ? "" : "border-b border-border-subtle"}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        disabled={props.disabled}
        onPress={props.onPress}
        className="min-h-12 min-w-0 flex-1 flex-row items-center gap-2 px-4 py-2.5 active:bg-subtle"
      >
        {props.children}
      </Pressable>
      {props.trailing ? <View className="pr-3">{props.trailing}</View> : null}
    </View>
  );
}

function CommentCard(props: {
  readonly comment: KanbanComment;
  readonly lookups: KanbanLookups;
  readonly colors: KanbanGlyphColors;
  readonly now: Date;
  readonly textStyle: ReturnType<typeof useMarkdownPreviewStyles>["nativeTextStyle"];
  readonly deleting: boolean;
  readonly onDelete: ((comment: KanbanComment) => void) | null;
}) {
  const { comment } = props;
  const author =
    comment.authorId === null
      ? {
          id: "integration",
          name: comment.authorName,
          avatarUrl: comment.authorAvatarUrl,
          botId: null,
        }
      : {
          ...personDisplay(props.lookups, comment.authorId, comment.authorName),
          ...(comment.authorAvatarUrl === null ? {} : { avatarUrl: comment.authorAvatarUrl }),
        };
  return (
    <View
      className={`gap-2 rounded-2xl bg-grouped-card p-3 ${comment.parentId === null ? "" : "ml-6"}`}
      style={{ opacity: props.deleting ? 0.5 : 1 }}
    >
      <View className="flex-row items-center gap-2">
        <KanbanAvatar person={author} colors={props.colors} size={20} />
        <Text className="min-w-0 shrink font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {author.name}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {`${formatKanbanDate(new Date(comment.createdAt), props.now)}${comment.editedAt === null ? "" : " · edited"}`}
        </Text>
        {props.onDelete !== null ? (
          <View className="ml-auto">
            <ControlPill
              icon="trash"
              accessibilityLabel="Delete comment"
              disabled={props.deleting}
              onPress={() => props.onDelete?.(comment)}
            />
          </View>
        ) : null}
      </View>
      <SelectableMarkdownText
        markdown={comment.body}
        textStyle={props.textStyle}
        onLinkPress={(href) => void Linking.openURL(href)}
      />
    </View>
  );
}
