import {
  KanbanTicketTitle,
  KANBAN_LIMITS,
  type EnvironmentId,
  type KanbanComment,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketDetail,
  type KanbanTicketId,
  type KanbanTicketPatch,
  type KanbanTicketStatus,
  type ThreadId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { Schema } from "effect";
import { CheckIcon, ExternalLinkIcon, LinkIcon, PencilIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactElement } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { RightPanelMaximizeControl } from "../../components/chat/PanelLayoutControls";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  commandFailureMessage,
  confirmDestructive,
  reportCommandResult,
} from "../botsSettingsShared";
import { KanbanIssueActivity } from "./KanbanIssueActivity";
import { KanbanIssueLinks } from "./KanbanIssueLinks";
import { KanbanIssueProperties } from "./KanbanIssueProperties";
import { statusPresentation } from "./kanbanIssue.logic";
import { personDisplay, type KanbanLookups } from "./kanbanLookups";
import { KanbanAvatar, KanbanPriorityIcon, KanbanStatusIcon } from "./KanbanPrimitives";

const isTitle = Schema.is(KanbanTicketTitle);

/** Which ticket a detail belongs to: the environment and the ticket id. */
const detailKey = (environmentId: EnvironmentId, ticketId: KanbanTicketId) =>
  `${environmentId}\u0000${ticketId}`;

type LoadedDetail = { readonly key: string; readonly state: DetailState };

/** What a detail read leaves on screen; an interrupted read keeps what was there. */
function loadedFrom(
  key: string,
  result: AtomCommandResult<KanbanTicketDetail, unknown>,
  previous: LoadedDetail | null,
): LoadedDetail | null {
  if (result._tag === "Success") return { key, state: { kind: "ready", detail: result.value } };
  const message = commandFailureMessage(result);
  return message === null ? previous : { key, state: { kind: "failed", message } };
}

type DetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly detail: KanbanTicketDetail };

/**
 * One ticket opened beside the board, laid out like Linear's issue page: title, parent,
 * description, sub-issues and activity, with properties, pull requests and threads. Maximized it
 * splits into a content column and a sidebar; as a panel it is one column.
 */
export function KanbanIssueView(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
  readonly snapshot: KanbanSnapshot;
  readonly lookups: KanbanLookups;
  readonly projectTitle: string;
  readonly canEdit: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly onClose: () => void;
  /** Opens the parent or a sub-issue on the board. */
  readonly onOpenTicket: (ticketId: KanbanTicketId) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, ticket, snapshot, lookups, canEdit } = props;
  const loadDetail = useAtomCommand(botsEnvironment.kanbanTicketDetail, {
    label: "kanban ticket detail",
    reportFailure: false,
  });
  const update = useAtomCommand(botsEnvironment.kanbanUpdateTicket, { label: "kanban update" });
  const move = useAtomCommand(botsEnvironment.kanbanMoveTicket, { label: "kanban move" });
  const comment = useAtomCommand(botsEnvironment.kanbanComment, { label: "kanban comment" });
  const deleteComment = useAtomCommand(botsEnvironment.kanbanDeleteComment, {
    label: "kanban delete comment",
  });
  const key = detailKey(environmentId, ticket.id);
  const [loaded, setLoaded] = useState<LoadedDetail | null>(null);
  const state: DetailState =
    loaded !== null && loaded.key === key ? loaded.state : { kind: "loading" };
  const request = useRef(0);
  // The ticket on screen; a write that finishes after a switch must not touch the next one's read.
  const activeKey = useRef(key);

  const refetch = async () => {
    if (activeKey.current !== key) return;
    const current = ++request.current;
    const result = await loadDetail({ environmentId, input: { ticketId: ticket.id } });
    if (current === request.current && activeKey.current === key)
      setLoaded((previous) => loadedFrom(key, result, previous));
  };
  const readDetail = useEffectEvent(() =>
    loadDetail({ environmentId, input: { ticketId: ticket.id } }),
  );
  const close = useEffectEvent(() => props.onClose());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the issue detail from the server when a ticket opens
  useEffect(() => {
    activeKey.current = key;
    const current = ++request.current;
    void readDetail().then((result) => {
      if (current === request.current) {
        setLoaded((previous) => loadedFrom(key, result, previous));
      }
    });
  }, [key]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Esc anywhere outside a field or popup closes the issue
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            "input, textarea, select, [role='menu'], [role='dialog'], [role='listbox']",
          ))
      )
        return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const patch = async (value: KanbanTicketPatch): Promise<boolean> => {
    const ok = reportCommandResult(
      `Could not update ${ticket.identifier}`,
      await update({ environmentId, input: { ticketId: ticket.id, patch: value } }),
    );
    if (ok) await refetch();
    return ok;
  };
  const moveTo = async (to: KanbanTicketStatus): Promise<boolean> => {
    const ok = reportCommandResult(
      `Could not move ${ticket.identifier}`,
      await move({ environmentId, input: { ticketId: ticket.id, to } }),
    );
    if (ok) await refetch();
    return ok;
  };
  const addComment = async (body: string): Promise<boolean> => {
    const ok = reportCommandResult(
      "Could not add the comment",
      await comment({ environmentId, input: { ticketId: ticket.id, body } }),
    );
    if (ok) await refetch();
    return ok;
  };
  const removeComment = async (target: KanbanComment) => {
    if (!(await confirmDestructive(`Delete this comment?\n${target.body.slice(0, 120)}`))) return;
    const ok = reportCommandResult(
      "Could not delete the comment",
      await deleteComment({ environmentId, input: { ticketId: ticket.id, commentId: target.id } }),
    );
    if (ok) void refetch();
  };

  const link = snapshot.links.find((candidate) => candidate.projectId === ticket.projectId);
  const crumb = ticket.linear !== null && link !== undefined ? link.teamName : props.projectTitle;
  const detail = state.kind === "ready" ? state.detail : null;

  const properties = (layout: "sidebar" | "compact") => (
    <KanbanIssueProperties
      environmentId={environmentId}
      ticket={ticket}
      snapshot={snapshot}
      lookups={lookups}
      canEdit={canEdit}
      layout={layout}
      onPatch={patch}
      onMove={moveTo}
    />
  );
  const links = (
    <KanbanIssueLinks
      environmentId={environmentId}
      ticket={ticket}
      snapshot={snapshot}
      canEdit={canEdit}
      onOpenThread={props.onOpenThread}
    />
  );
  const content = (
    <>
      <IssueTitle
        key={ticket.id}
        title={ticket.title}
        canEdit={canEdit}
        onSave={(title) => patch({ title })}
      />
      <ParentLine
        ticket={ticket}
        detail={detail}
        snapshot={snapshot}
        lookups={lookups}
        onOpenTicket={props.onOpenTicket}
      />
      {props.maximized ? null : (
        <div className="mt-4 flex flex-col gap-4 border-b border-border/60 pb-4">
          {properties("compact")}
          {links}
        </div>
      )}
      <div className="mt-5">
        {state.kind === "loading" ? (
          <DetailSkeleton />
        ) : state.kind === "failed" ? (
          <p className="text-destructive text-sm" role="alert">
            {state.message}
          </p>
        ) : (
          <div className="flex flex-col gap-8">
            <Description
              key={ticket.id}
              environmentId={environmentId}
              description={state.detail.description}
              startEditing={ticket.linear === null && state.detail.description === null}
              canEdit={canEdit}
              onSave={(description) => patch({ description })}
            />
            <SubIssues detail={state.detail} lookups={lookups} onOpenTicket={props.onOpenTicket} />
            <div className="border-t border-border/60 pt-6">
              <KanbanIssueActivity
                environmentId={environmentId}
                detail={state.detail}
                canEdit={canEdit}
                onComment={addComment}
                onDeleteComment={(target) => void removeComment(target)}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <IssueHeader
        crumb={crumb}
        identifier={ticket.identifier}
        linearUrl={ticket.linear?.url ?? null}
        maximized={props.maximized}
        onToggleMaximized={props.onToggleMaximized}
        onClose={props.onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        {props.maximized ? (
          <div className="mx-auto flex w-full max-w-6xl gap-10 px-8 py-8">
            <main className="mx-auto min-w-0 max-w-3xl flex-1">{content}</main>
            <aside className="flex w-72 shrink-0 flex-col gap-6">
              {links}
              {properties("sidebar")}
            </aside>
          </div>
        ) : (
          <main className="px-5 py-5">{content}</main>
        )}
      </div>
    </div>
  );
}

function IssueHeader(props: {
  readonly crumb: string;
  readonly identifier: string;
  readonly linearUrl: string | null;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly onClose: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "issue link" });
  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pr-2 pl-4">
      <nav aria-label="Issue" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <span className="truncate text-muted-foreground">{props.crumb}</span>
        <span aria-hidden className="text-muted-foreground/60">
          ›
        </span>
        <span className="shrink-0 font-medium">{props.identifier}</span>
      </nav>
      <HeaderButton label={isCopied ? "Copied" : "Copy link"}>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Copy link"
          onClick={() => copyToClipboard(window.location.href, undefined)}
        >
          {isCopied ? <CheckIcon /> : <LinkIcon />}
        </Button>
      </HeaderButton>
      {props.linearUrl !== null ? (
        <HeaderButton label="Open in Linear">
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Open in Linear"
            onClick={() => window.open(props.linearUrl ?? undefined, "_blank", "noopener")}
          >
            <ExternalLinkIcon />
          </Button>
        </HeaderButton>
      ) : null}
      <RightPanelMaximizeControl maximized={props.maximized} onToggle={props.onToggleMaximized} />
      <HeaderButton label="Close">
        <Button size="icon-sm" variant="ghost-muted" aria-label="Close" onClick={props.onClose}>
          <XIcon />
        </Button>
      </HeaderButton>
    </header>
  );
}

function HeaderButton(props: { readonly label: string; readonly children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function IssueTitle(props: {
  readonly title: string;
  readonly canEdit: boolean;
  readonly onSave: (title: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Esc unmounts the field, and a browser may still fire its blur; that blur must not save.
  const cancelled = useRef(false);
  if (draft === null) {
    return props.canEdit ? (
      <h1>
        <button
          type="button"
          className="w-full cursor-text rounded-md text-left font-semibold text-2xl leading-tight hover:bg-accent/40"
          onClick={() => {
            cancelled.current = false;
            setDraft(props.title);
          }}
        >
          {props.title}
        </button>
      </h1>
    ) : (
      <h1 className="font-semibold text-2xl leading-tight">{props.title}</h1>
    );
  }
  const save = async () => {
    if (cancelled.current) return;
    const title = draft.trim();
    if (title === props.title) {
      setDraft(null);
      return;
    }
    if (!isTitle(title) || saving) return;
    setSaving(true);
    const ok = await props.onSave(title);
    setSaving(false);
    if (ok) setDraft(null);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        autoFocus
        aria-label="Title"
        value={draft}
        disabled={saving}
        maxLength={KANBAN_LIMITS.title}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancelled.current = true;
            setDraft(null);
          }
        }}
        onBlur={() => void save()}
      />
    </form>
  );
}

function ParentLine(props: {
  readonly ticket: KanbanTicket;
  readonly detail: KanbanTicketDetail | null;
  readonly snapshot: KanbanSnapshot;
  readonly lookups: KanbanLookups;
  readonly onOpenTicket: (ticketId: KanbanTicketId) => void;
}) {
  const parent =
    props.detail?.parent ??
    (props.ticket.parent && { ...props.ticket.parent, ticketId: null, status: null });
  if (!parent) return null;
  const parentTicket =
    parent.ticketId === null
      ? undefined
      : props.snapshot.tickets.find((candidate) => candidate.id === parent.ticketId);
  const status = parent.status ?? parentTicket?.status ?? null;
  const presentation =
    status === null ? null : statusPresentation(status, props.lookups.statesById);
  const progress = parentTicket?.subIssues ?? null;
  const linearUrl = props.ticket.linear?.url;
  const open = () => {
    if (parent.ticketId !== null) props.onOpenTicket(parent.ticketId);
    else if (linearUrl !== undefined) {
      // Linear issue URLs end in the identifier and a slug; swap them for the parent's.
      const base = linearUrl.replace(/\/issue\/.*$/, "");
      window.open(`${base}/issue/${parent.identifier}`, "_blank", "noopener");
    }
  };
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
      <span className="shrink-0">Sub-issue of</span>
      <button
        type="button"
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 hover:bg-accent"
        onClick={open}
      >
        {presentation ? (
          <KanbanStatusIcon
            stateType={presentation.stateType}
            color={presentation.color}
            size={14}
            {...(presentation.progress === undefined ? {} : { progress: presentation.progress })}
          />
        ) : null}
        <span className="shrink-0">{parent.identifier}</span>
        <span className="truncate text-foreground">{parent.title}</span>
      </button>
      {progress !== null && progress.total > 0 ? (
        <span className="shrink-0 rounded-full border px-1.5 text-xs tabular-nums">
          {progress.closed}/{progress.total}
        </span>
      ) : null}
    </div>
  );
}

function Description(props: {
  readonly environmentId: EnvironmentId;
  readonly description: string | null;
  readonly startEditing: boolean;
  readonly canEdit: boolean;
  readonly onSave: (description: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(
    props.canEdit && props.startEditing ? "" : null,
  );
  const [saving, setSaving] = useState(false);

  if (draft !== null) {
    const save = async () => {
      setSaving(true);
      const ok = await props.onSave(draft);
      setSaving(false);
      if (ok) setDraft(null);
    };
    const changed = draft !== (props.description ?? "");
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          aria-label="Description"
          placeholder="Add description…"
          value={draft}
          disabled={saving}
          maxLength={KANBAN_LIMITS.description}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && changed) {
              event.preventDefault();
              void save();
            }
          }}
        />
        <div className="flex justify-end gap-1.5">
          {props.description !== null || !props.startEditing ? (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" disabled={saving || !changed} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }
  if (props.description === null) {
    return props.canEdit ? (
      <Button size="sm" variant="ghost-muted" className="self-start" onClick={() => setDraft("")}>
        Add description…
      </Button>
    ) : (
      <p className="text-muted-foreground text-sm">No description.</p>
    );
  }
  return (
    <div className="group relative min-w-0 text-sm">
      <ChatMarkdown text={props.description} cwd={undefined} environmentId={props.environmentId} />
      {props.canEdit ? (
        <div className="absolute top-0 right-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button size="xs" variant="ghost-muted" onClick={() => setDraft(props.description ?? "")}>
            <PencilIcon />
            Edit
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SubIssues(props: {
  readonly detail: KanbanTicketDetail;
  readonly lookups: KanbanLookups;
  readonly onOpenTicket: (ticketId: KanbanTicketId) => void;
}) {
  const children = props.detail.children;
  if (children.length === 0) return null;
  return (
    <section aria-label="Sub-issues" className="flex flex-col gap-1">
      <h2 className="mb-1 font-medium text-sm">
        Sub-issues <span className="font-normal text-muted-foreground">{children.length}</span>
      </h2>
      <ul className="flex flex-col">
        {children.map((child) => {
          const presentation = statusPresentation(child.status, props.lookups.statesById);
          const assignee =
            child.assigneeId === null ? null : personDisplay(props.lookups, child.assigneeId);
          const open = () => {
            if (child.ticketId !== null) props.onOpenTicket(child.ticketId);
            else if (child.url !== null) window.open(child.url, "_blank", "noopener");
          };
          return (
            <li key={child.issueId}>
              <button
                type="button"
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={open}
              >
                {presentation ? (
                  <KanbanStatusIcon
                    stateType={presentation.stateType}
                    color={presentation.color}
                    size={14}
                    {...(presentation.progress === undefined
                      ? {}
                      : { progress: presentation.progress })}
                  />
                ) : null}
                <span className="shrink-0 text-muted-foreground text-xs">{child.identifier}</span>
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                <KanbanPriorityIcon priority={child.priority} size={14} />
                <KanbanAvatar person={assignee} size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading the issue">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
