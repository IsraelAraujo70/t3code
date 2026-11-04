import { useAtomValue } from "@effect/atom-react";
import { workflowRunHref } from "@t3tools/client-runtime/workflows";
import {
  EnvironmentId,
  WorkflowId,
  type KanbanTicket,
  type ProjectId,
  type WorkflowDocument,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, PlayIcon, WorkflowIcon, XIcon } from "lucide-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "../botsSettingsShared";
import { useWorkflowsSnapshot, workflowsEnvironment } from "../workflows/state";
import {
  selectionBlockReason,
  ticketsRunCheck,
  ticketWorkflowOption,
  TICKETS_PARAM,
  workflowModelLabels,
  type TicketWorkflowOption,
} from "./kanbanRunWorkflow.logic";

type RunnableOption = Extract<TicketWorkflowOption, { kind: "runnable" }>;

/** The bar over the board while cards are selected: the count, Clear, and Run workflow. */
export function KanbanSelectionBar(props: {
  readonly environmentId: EnvironmentId;
  readonly tickets: ReadonlyArray<KanbanTicket>;
  readonly projectTitles: ReadonlyMap<ProjectId, string>;
  readonly onClear: () => void;
}) {
  const [picked, setPicked] = useState<RunnableOption | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const blocked = selectionBlockReason(props.tickets.length);
  const runButton = (
    <Button size="xs" variant="outline" disabled={blocked !== null}>
      <WorkflowIcon />
      Run workflow
      <ChevronDownIcon />
    </Button>
  );
  return (
    <div
      role="toolbar"
      aria-label="Selected cards"
      className="mx-(--workspace-gutter-start) mb-2 flex items-center gap-2 rounded-lg border bg-card px-2 py-1 text-sm shadow-xs/5"
    >
      <span className="font-medium tabular-nums">{props.tickets.length} selected</span>
      <Button size="xs" variant="ghost-muted" onClick={props.onClear}>
        <XIcon />
        Clear
      </Button>
      {blocked !== null ? <span className="text-muted-foreground text-xs">{blocked}</span> : null}
      <span className="ml-auto">
        {blocked !== null ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>{runButton}</TooltipTrigger>
            <TooltipPopup side="bottom">{blocked}</TooltipPopup>
          </Tooltip>
        ) : (
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger render={runButton} />
            <MenuPopup align="end" className="max-h-96 w-80 overflow-y-auto">
              {menuOpen ? (
                <TicketWorkflowItems
                  environmentId={props.environmentId}
                  tickets={props.tickets}
                  onPick={setPicked}
                />
              ) : null}
            </MenuPopup>
          </Menu>
        )}
      </span>
      {picked === null ? null : (
        <RunWorkflowPreview
          environmentId={props.environmentId}
          option={picked}
          tickets={props.tickets}
          projectTitles={props.projectTitles}
          onClose={() => setPicked(null)}
          onStarted={() => {
            setPicked(null);
            props.onClear();
          }}
        />
      )}
    </div>
  );
}

/**
 * Every listed workflow's document at once, so the menu knows which take `tickets`. Keyed by
 * environment and ids joined, since each snapshot hands over a new array of the same ids.
 */
const workflowDocumentsAtom = Atom.family((key: string) => {
  const [environmentId, ...workflowIds] = key.split("\n");
  return Atom.make((get) => {
    const documents = new Map<string, WorkflowDocument>();
    for (const workflowId of workflowIds) {
      const result = get(
        workflowsEnvironment.document({
          environmentId: EnvironmentId.make(environmentId ?? ""),
          input: { workflowId: WorkflowId.make(workflowId) },
        }),
      );
      const document = AsyncResult.getOrElse(result, () => null);
      if (document !== null) documents.set(workflowId, document);
    }
    return documents;
  });
});

function TicketWorkflowItems(props: {
  readonly environmentId: EnvironmentId;
  readonly tickets: ReadonlyArray<KanbanTicket>;
  readonly onPick: (option: RunnableOption) => void;
}) {
  const snapshot = useWorkflowsSnapshot(props.environmentId);
  const summaries = (snapshot.data?.workflows ?? []).filter((summary) => summary.valid);
  const documents = useAtomValue(
    workflowDocumentsAtom(
      [props.environmentId, ...summaries.map((summary) => summary.workflowId)].join("\n"),
    ),
  );
  const options = summaries.flatMap(
    (summary) => ticketWorkflowOption(summary, documents.get(summary.workflowId) ?? null) ?? [],
  );
  const loading = snapshot.data === null || options.some((option) => option.kind === "loading");

  return (
    <MenuGroup>
      <MenuGroupLabel>Workflows that take cards</MenuGroupLabel>
      {snapshot.error !== null ? (
        <p className="px-2 py-1.5 text-destructive text-xs">{snapshot.error}</p>
      ) : null}
      {options.map((option) => {
        if (option.kind === "loading") return null;
        const check = option.kind === "runnable" ? ticketsRunCheck(option, props.tickets) : null;
        const reason =
          option.kind === "unavailable" ? option.reason : check?.ok ? null : check?.reason;
        return (
          <MenuItem
            key={option.summary.workflowId}
            disabled={reason !== null && reason !== undefined}
            onClick={() => {
              if (option.kind === "runnable") props.onPick(option);
            }}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{option.summary.title}</span>
              {reason ? (
                <span className="text-muted-foreground text-xs">{reason}</span>
              ) : option.kind === "runnable" ? (
                <span className="text-muted-foreground text-xs">Up to {option.limit} cards</span>
              ) : null}
            </span>
          </MenuItem>
        );
      })}
      {loading ? (
        <p className="px-2 py-1.5 text-muted-foreground text-xs">Loading workflows…</p>
      ) : options.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground text-xs">
          No workflow declares a <code>{TICKETS_PARAM}</code> list param.
        </p>
      ) : null}
    </MenuGroup>
  );
}

/** What the run will take, then Run or Cancel. Server refusals stay in the dialog. */
function RunWorkflowPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly option: RunnableOption;
  readonly tickets: ReadonlyArray<KanbanTicket>;
  readonly projectTitles: ReadonlyMap<ProjectId, string>;
  readonly onClose: () => void;
  readonly onStarted: () => void;
}) {
  const { option } = props;
  const navigate = useNavigate();
  const runStart = useAtomCommand(workflowsEnvironment.runStart, { label: "workflow run" });
  const canRun = useAtomValue(workflowsEnvironment.runStart.permissionAtom(props.environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = ticketsRunCheck(option, props.tickets);
  const blocked = !canRun
    ? "This session may not start workflow runs."
    : check.ok
      ? null
      : check.reason;
  const models = workflowModelLabels(option.definition);
  const bot = option.summary.bot ?? null;

  const run = async () => {
    if (!check.ok) return;
    setPending(true);
    setError(null);
    const result = await runStart({
      environmentId: props.environmentId,
      input: {
        workflowId: option.summary.workflowId,
        params: check.params,
        clientRequestId: randomUUID(),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(commandFailureMessage(result));
      return;
    }
    const href = workflowRunHref(props.environmentId, result.value.runId);
    toastManager.add({
      type: "success",
      title: `Started ${option.summary.title}`,
      description: `${props.tickets.length} ${props.tickets.length === 1 ? "card" : "cards"}`,
      actionProps: { children: "Open run", onClick: () => void navigate({ href }) },
    });
    props.onStarted();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run {option.summary.title}</DialogTitle>
          <DialogDescription>
            One run with these {props.tickets.length} cards as <code>{TICKETS_PARAM}</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">
            {props.tickets.map((ticket) => (
              <li key={ticket.id} className="flex items-baseline gap-2 px-3 py-1.5">
                <span className="w-20 shrink-0 truncate text-muted-foreground text-xs">
                  {ticket.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                <span className="max-w-32 shrink-0 truncate text-muted-foreground text-xs">
                  {props.projectTitles.get(ticket.projectId) ?? ""}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Model</dt>
            <dd>{models.length > 0 ? models.join(", ") : "Set by each step"}</dd>
            <dt className="text-muted-foreground">Bot</dt>
            <dd>{bot === null ? "None" : (bot.name ?? "A deleted bot")}</dd>
          </dl>
          {blocked !== null ? <p className="mt-3 text-sm text-destructive">{blocked}</p> : null}
          {error !== null ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={blocked !== null || pending} onClick={() => void run()}>
            <PlayIcon />
            Run
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
