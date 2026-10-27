import {
  KANBAN_LIMITS,
  type EnvironmentId,
  type KanbanComment,
  type KanbanTicketDetail,
} from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { issueTimeline, minuteEpoch, relativeTimeLabel } from "./kanbanIssue.logic";
import type { KanbanPersonDisplay } from "./kanbanLookups";
import { KanbanAvatar } from "./KanbanPrimitives";

const personOf = (
  id: string | null,
  name: string,
  avatarUrl: string | null,
): KanbanPersonDisplay => ({
  id: id ?? `name:${name}`,
  name,
  avatarUrl,
  botId: id?.startsWith("bot:") ? id.slice("bot:".length) : null,
});

/** History lines and comments, oldest first, then a composer for a new comment. */
export function KanbanIssueActivity(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: KanbanTicketDetail;
  readonly canEdit: boolean;
  readonly onComment: (body: string) => Promise<boolean>;
  readonly onDeleteComment: (comment: KanbanComment) => void;
}) {
  const now = minuteEpoch(useNowMinute());
  const timeline = issueTimeline(props.detail.activity, props.detail.comments);
  return (
    <section aria-label="Activity" className="flex flex-col gap-3">
      <h2 className="font-medium text-sm">Activity</h2>
      {timeline.length === 0 ? (
        <p className="text-muted-foreground text-xs">No activity yet.</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {timeline.map((entry) =>
            entry.kind === "activity" ? (
              <li
                key={entry.id}
                className="flex items-start gap-2 px-1 text-muted-foreground text-xs"
              >
                <span className="mt-px shrink-0">
                  <KanbanAvatar
                    person={personOf(
                      entry.activity.actorId,
                      entry.activity.actorName,
                      entry.activity.actorAvatarUrl,
                    )}
                    size={14}
                  />
                </span>
                <span className="min-w-0">
                  <span className="text-foreground/80">{entry.activity.actorName}</span>{" "}
                  {entry.activity.text}
                  <span>
                    {" · "}
                    {relativeTimeLabel(entry.activity.createdAt, now)}
                  </span>
                </span>
              </li>
            ) : (
              <li key={entry.id}>
                <CommentCard
                  environmentId={props.environmentId}
                  comment={entry.comment}
                  now={now}
                  canDelete={props.canEdit && entry.comment.deletable}
                  onDelete={() => props.onDeleteComment(entry.comment)}
                />
              </li>
            ),
          )}
        </ol>
      )}
      {props.canEdit ? <CommentComposer onComment={props.onComment} /> : null}
    </section>
  );
}

function CommentCard(props: {
  readonly environmentId: EnvironmentId;
  readonly comment: KanbanComment;
  readonly now: number;
  readonly canDelete: boolean;
  readonly onDelete: () => void;
}) {
  const { comment } = props;
  return (
    <article className="rounded-lg border bg-card px-3 py-2.5 text-card-foreground">
      <header className="flex items-center gap-2 text-xs">
        <KanbanAvatar
          person={personOf(comment.authorId, comment.authorName, comment.authorAvatarUrl)}
          size={16}
        />
        <span className="truncate font-medium">{comment.authorName}</span>
        <span className="shrink-0 text-muted-foreground">
          {relativeTimeLabel(comment.createdAt, props.now)}
          {comment.editedAt !== null ? " (edited)" : ""}
        </span>
        <span className="flex-1" />
        {props.canDelete ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Delete ${comment.authorName}'s comment`}
            onClick={props.onDelete}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </header>
      <div className="mt-1.5 min-w-0 text-sm">
        <ChatMarkdown text={comment.body} cwd={undefined} environmentId={props.environmentId} />
      </div>
    </article>
  );
}

function CommentComposer(props: { readonly onComment: (body: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const body = draft.trim();
  const canSend = body !== "" && body.length <= KANBAN_LIMITS.comment && !sending;
  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await props.onComment(body);
    setSending(false);
    if (ok) setDraft("");
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        aria-label="Comment"
        placeholder="Leave a comment…"
        value={draft}
        disabled={sending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="secondary" disabled={!canSend}>
          {sending ? "Sending…" : "Comment"}
        </Button>
      </div>
    </form>
  );
}
