import type { WorkflowRunSummary, WorkflowSummary } from "@t3tools/contracts";
import {
  runNeedsYou,
  runStatusLabel,
  runStatusTone,
  type ActiveWorkflowRun,
} from "@t3tools/client-runtime/workflows";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import type { MenuProps } from "../../components/ui/Menu.types";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { BotAvatar } from "../BotAvatar";
import { runIcon, StatusGlyph, StatusLabel } from "./WorkflowStatus";
import { needsYouLine, runMetaLine, triggersLine, workflowFlag } from "./workflowsScreen.logic";

function BotLine(props: {
  readonly bot: WorkflowSummary["bot"];
  readonly text: string;
  readonly time: string | null;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      {props.bot ? <BotAvatar botId={props.bot.id} size={16} /> : null}
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {props.text}
      </Text>
      {props.time ? (
        <Text className="text-2xs tabular-nums text-foreground-tertiary">{props.time}</Text>
      ) : null}
    </View>
  );
}

const botName = (bot: WorkflowSummary["bot"]) =>
  bot ? (bot.name ?? `${bot.id} (deleted)`) : "No bot";

/**
 * A workflow as the PR list shows a pull request: its bot and last run time on top, the title,
 * then its triggers with the last run's status. Touch and hold for Run now and the switch.
 */
export const WorkflowRow = memo(function WorkflowRow(props: {
  readonly workflow: WorkflowSummary;
  readonly onPress: (workflow: WorkflowSummary) => void;
  readonly actions: MenuProps["actions"];
  readonly onAction: (workflow: WorkflowSummary, action: string) => void;
}) {
  const { workflow } = props;
  const last = workflow.lastRun;
  const needsYou = last !== null && runNeedsYou(last);
  const flag = workflowFlag(workflow);
  const triggers = triggersLine(workflow);
  return (
    <Menu
      shouldOpenOnLongPress
      title={workflow.title}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onAction(workflow, nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${workflow.title}, ${botName(workflow.bot)}${flag ? `, ${flag.label}` : ""}${last ? `, last run ${needsYou ? "needs you" : runStatusLabel(last.status)}` : ", never run"}`}
        accessibilityHint="Double tap to open. Touch and hold for Run now and the switch."
        onPress={() => props.onPress(workflow)}
        className="flex-row gap-3 px-4 active:bg-row-hover"
      >
        <View className="self-start pt-2.5">
          <StatusGlyph
            icon={last ? runIcon(last.status, needsYou) : "circle"}
            tone={last ? (needsYou ? "warning" : runStatusTone(last.status)) : "muted"}
            size={20}
          />
        </View>
        <View
          className={cn(
            "min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5",
            !workflow.enabled && "opacity-70",
          )}
        >
          <BotLine
            bot={workflow.bot}
            text={botName(workflow.bot)}
            time={last ? relativeTime(last.startedAt) : null}
          />
          <Text className="text-base leading-5 font-t3-medium text-foreground" numberOfLines={2}>
            {workflow.title}
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={1}>
              {triggers ?? "No triggers"}
            </Text>
            {flag ? (
              <StatusLabel
                icon={flag.tone === "muted" ? "circle" : "exclamationmark.triangle"}
                label={flag.label}
                tone={flag.tone}
              />
            ) : last ? (
              <StatusLabel
                icon={runIcon(last.status, needsYou)}
                label={needsYou ? "Needs you" : runStatusLabel(last.status)}
                tone={needsYou ? "warning" : runStatusTone(last.status)}
              />
            ) : (
              <Text className="text-2xs text-foreground-tertiary">Never run</Text>
            )}
          </View>
        </View>
      </Pressable>
    </Menu>
  );
});

/**
 * A run: the workflow and its bot on top, the run's title, then trigger, time and tokens. A run
 * that waits for the user says why in place of the meta line.
 */
export const RunRow = memo(function RunRow(props: {
  readonly run: WorkflowRunSummary;
  readonly workflow: WorkflowSummary | null;
  /** Hidden inside a workflow's own page, where every run is that workflow's. */
  readonly showWorkflow: boolean;
  readonly nowMs: number;
  readonly onPress: (run: WorkflowRunSummary) => void;
}) {
  const { run, workflow } = props;
  const needsYou = runNeedsYou(run);
  const tone = needsYou ? "warning" : runStatusTone(run.status);
  const status = needsYou ? "Needs you" : runStatusLabel(run.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${run.title}, ${status}, started ${relativeTime(run.startedAt, props.nowMs)} ago`}
      accessibilityHint="Double tap to open the run."
      onPress={() => props.onPress(run)}
      className="flex-row gap-3 px-4 active:bg-row-hover"
    >
      <View className="self-start pt-2.5">
        <StatusGlyph icon={runIcon(run.status, needsYou)} tone={tone} size={20} />
      </View>
      <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
        <BotLine
          bot={props.showWorkflow ? workflow?.bot : null}
          text={props.showWorkflow ? (workflow?.title ?? run.workflowId) : status}
          time={relativeTime(run.startedAt, props.nowMs)}
        />
        <Text className="text-base leading-5 font-t3-medium text-foreground" numberOfLines={2}>
          {run.title}
        </Text>
        {needsYou ? (
          <Text className="text-xs text-warning-foreground" numberOfLines={2}>
            {needsYouLine(run)}
          </Text>
        ) : (
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={1}>
              {runMetaLine(run, props.nowMs)}
            </Text>
            {props.showWorkflow ? (
              <StatusLabel icon={runIcon(run.status, false)} label={status} tone={tone} />
            ) : null}
          </View>
        )}
      </View>
    </Pressable>
  );
});

/**
 * A run that waits for the user, at the top of Workflows: whose it is, for how long, why, and the
 * button that answers it. A pause has no gate to answer here, so it opens the run to resume.
 */
export function NeedsYouCard(props: {
  readonly item: ActiveWorkflowRun;
  readonly nowMs: number;
  readonly onAnswer: (run: WorkflowRunSummary) => void;
  readonly onOpen: (run: WorkflowRunSummary) => void;
}) {
  const { run, workflow, since } = props.item;
  const gated = run.openGates > 0;
  return (
    <View className="gap-2 rounded-2xl border border-warning-border bg-warning p-3.5">
      <BotLine
        bot={workflow?.bot}
        text={workflow?.title ?? run.title}
        time={`waiting ${relativeTime(since, props.nowMs)}`}
      />
      <Text className="text-base leading-5 font-t3-medium text-foreground" numberOfLines={2}>
        {run.title}
      </Text>
      <Text className="text-sm leading-5 text-warning-foreground" numberOfLines={3}>
        {needsYouLine(run)}
      </Text>
      <View className="flex-row gap-2 pt-1">
        {gated ? (
          <Button label="Answer" tone="primary" onPress={() => props.onAnswer(run)} />
        ) : null}
        <Button
          label={gated ? "Open run" : "Open run to resume"}
          tone={gated ? "text" : "primary"}
          onPress={() => props.onOpen(run)}
        />
      </View>
    </View>
  );
}
