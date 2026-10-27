import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  HistoryNode,
  IssueDetailNode,
  IssueNode,
  parsePullRequest,
  phraseHistory,
  toIssue,
  toIssueDetail,
} from "./linearMapping.ts";

const decodeHistory = Schema.decodeSync(HistoryNode);
const decodeIssue = Schema.decodeSync(IssueNode);
const decodeDetail = Schema.decodeSync(IssueDetailNode);

const ISRAEL = {
  id: "548a2f27-f621-4a7c-b1bb-e0e8ecb2879c",
  name: "Israel Araujo de Oliveria",
  displayName: "israel.araujo",
  avatarUrl: null,
};

const history = (changes: Partial<typeof HistoryNode.Encoded>) =>
  decodeHistory({
    id: "8943d53b-7abd-43a2-9716-35fd8e9370ce",
    createdAt: "2026-10-27T12:17:07.811Z",
    actor: ISRAEL,
    botActor: null,
    fromState: null,
    toState: null,
    fromAssignee: null,
    toAssignee: null,
    fromPriority: null,
    toPriority: null,
    addedLabels: null,
    removedLabels: null,
    fromParent: null,
    toParent: null,
    fromTitle: null,
    toTitle: null,
    fromDueDate: null,
    toDueDate: null,
    fromProject: null,
    toProject: null,
    fromCycle: null,
    toCycle: null,
    fromEstimate: null,
    toEstimate: null,
    archived: null,
    trashed: null,
    autoClosed: null,
    autoArchived: null,
    ...changes,
  });

const attachment = {
  id: "att-33",
  url: "https://github.com/Moneria-Brasil/moneria-iac/pull/33",
  title: "fix(msk): require IAM auth",
  sourceType: "github",
  metadata: {
    url: "https://github.com/Moneria-Brasil/moneria-iac/pull/33",
    draft: false,
    number: 33,
    status: "open",
    mergedAt: null,
    closedAt: null,
    repoLogin: "Moneria-Brasil",
    repoName: "moneria-iac",
  },
};

const issueNode = (overrides: Partial<typeof IssueNode.Encoded> = {}) =>
  decodeIssue({
    id: "4b827181",
    identifier: "BACK-169",
    title: "MSK sem autenticação",
    url: "https://linear.app/moneria/issue/BACK-169",
    priority: 2,
    estimate: 0,
    dueDate: "2026-11-01",
    sortOrder: -12.5,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-27T12:17:07.811Z",
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    autoClosedAt: null,
    state: { id: "s-progress" },
    team: { id: "t-back" },
    assignee: { id: ISRAEL.id, name: ISRAEL.name },
    creator: { id: "kellen" },
    project: { id: "p-infra" },
    projectMilestone: { id: "m-1" },
    cycle: { id: "c-9" },
    parent: { id: "bc93d5c8", identifier: "BACK-186", title: "Pendências de infra do BACK-148" },
    children: { nodes: [] },
    labels: { nodes: [{ id: "l-bug" }, { id: "l-infra" }] },
    attachments: { nodes: [attachment] },
    ...overrides,
  });

describe("parsePullRequest", () => {
  it("reads the GitHub integration's attachment", () => {
    expect(parsePullRequest(attachment)).toEqual({
      attachmentId: "att-33",
      url: "https://github.com/Moneria-Brasil/moneria-iac/pull/33",
      repository: "Moneria-Brasil/moneria-iac",
      number: 33,
      title: "fix(msk): require IAM auth",
      state: "open",
    });
  });

  it.each([
    [{ status: "merged", mergedAt: null }, "merged"],
    [{ status: "closed", mergedAt: "2026-10-27T00:00:00.000Z" }, "merged"],
    [{ status: "closed", draft: true }, "closed"],
    [{ status: "open", draft: true }, "draft"],
    [{ status: "reopened" }, "open"],
    [{ draft: "yes" }, "open"],
    [null, "open"],
    ["garbage", "open"],
  ])("maps metadata %j to %s", (metadata, state) => {
    expect(parsePullRequest({ ...attachment, metadata })?.state).toBe(state);
  });

  it("ignores attachments that are not GitHub pull requests", () => {
    expect(parsePullRequest({ ...attachment, sourceType: "slack" })).toBeNull();
    expect(
      parsePullRequest({
        ...attachment,
        url: "https://github.com/Moneria-Brasil/moneria-iac/issues/33",
      }),
    ).toBeNull();
  });
});

describe("toIssue", () => {
  it("maps people, planning fields, parent and pull requests", () => {
    expect(toIssue(issueNode())).toMatchObject({
      stateId: "s-progress",
      teamId: "t-back",
      assigneeId: ISRAEL.id,
      assigneeName: ISRAEL.name,
      creatorId: "kellen",
      estimate: 0,
      dueDate: "2026-11-01",
      labelIds: ["l-bug", "l-infra"],
      projectId: "p-infra",
      milestoneId: "m-1",
      cycleId: "c-9",
      parent: { issueId: "bc93d5c8", identifier: "BACK-186" },
      subIssues: null,
      pullRequests: [{ number: 33, state: "open" }],
      sortOrder: -12.5,
      closedAt: null,
      autoClosed: false,
    });
  });

  it("counts completed, canceled and duplicate sub-issues as closed", () => {
    const children = ["completed", "canceled", "duplicate", "started", "backlog"].map((type) => ({
      id: type,
      state: { type },
    }));
    expect(toIssue(issueNode({ children: { nodes: children } })).subIssues).toEqual({
      total: 5,
      closed: 3,
    });
  });

  it("reads closing and auto-close from the timestamps", () => {
    const canceled = toIssue(
      issueNode({
        canceledAt: "2026-10-26T00:00:00.000Z",
        autoClosedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
    expect(canceled).toMatchObject({ closedAt: "2026-10-26T00:00:00.000Z", autoClosed: true });
    const unassigned = toIssue(issueNode({ assignee: null, parent: null, cycle: null }));
    expect(unassigned).toMatchObject({
      assigneeId: null,
      assigneeName: null,
      parent: null,
      cycleId: null,
    });
  });
});

describe("toIssueDetail", () => {
  it("flattens the parent, children and comment replies", () => {
    const detail = toIssueDetail(
      decodeDetail({
        id: "4b827181",
        identifier: "BACK-169",
        description: "**Origem.** BACK-148, ponto 17.",
        parent: {
          id: "bc93d5c8",
          identifier: "BACK-186",
          title: "Pendências de infra do BACK-148",
          state: { id: "bb2cea2c" },
        },
        children: {
          nodes: [
            {
              id: "child",
              identifier: "BACK-170",
              title: "Child",
              priority: 3,
              url: "https://linear.app/moneria/issue/BACK-170",
              state: { id: "s-todo" },
              assignee: null,
            },
          ],
        },
        comments: {
          nodes: [
            {
              id: "d8dd44ff",
              body: "## Plano proposto",
              createdAt: "2026-10-26T18:00:00.000Z",
              editedAt: null,
              user: ISRAEL,
              botActor: null,
              parent: null,
            },
            {
              id: "reply",
              body: "ok",
              createdAt: "2026-10-26T19:00:00.000Z",
              editedAt: null,
              user: null,
              botActor: { name: "Linear", avatarUrl: null },
              parent: { id: "d8dd44ff" },
            },
          ],
        },
        history: { nodes: [] },
      }),
    );
    expect(detail.parent).toEqual({
      issueId: "bc93d5c8",
      identifier: "BACK-186",
      title: "Pendências de infra do BACK-148",
      stateId: "bb2cea2c",
    });
    expect(detail.children).toEqual([
      expect.objectContaining({ id: "child", stateId: "s-todo", assigneeId: null }),
    ]);
    expect(
      detail.comments.map((comment) => [comment.id, comment.parentId, comment.botActor?.name]),
    ).toEqual([
      ["d8dd44ff", null, undefined],
      ["reply", "d8dd44ff", "Linear"],
    ]);
  });
});

describe("phraseHistory", () => {
  it("phrases the entries of a real issue's history", () => {
    expect(
      phraseHistory(history({ fromState: { name: "Backlog" }, toState: { name: "Em Progresso" } })),
    ).toBe("changed status from Backlog to Em Progresso");
    expect(phraseHistory(history({ toAssignee: { name: ISRAEL.name } }))).toBe(
      `assigned to ${ISRAEL.name}`,
    );
    expect(
      phraseHistory(
        history({ fromParent: { identifier: "BACK-148" }, toParent: { identifier: "BACK-186" } }),
      ),
    ).toBe("changed parent issue from BACK-148 to BACK-186");
  });

  it("returns null for an entry with nothing to phrase, like Linear's attachment entries", () => {
    expect(
      phraseHistory(history({ actor: null, botActor: { name: "Linear", avatarUrl: null } })),
    ).toBeNull();
  });

  it("names priorities, including No priority", () => {
    expect(phraseHistory(history({ fromPriority: 2, toPriority: 1 }))).toBe(
      "changed priority from High to Urgent",
    );
    expect(phraseHistory(history({ fromPriority: 0, toPriority: 4 }))).toBe(
      "changed priority from No priority to Low",
    );
  });

  it("phrases additions and removals", () => {
    expect(phraseHistory(history({ fromAssignee: { name: "Ana" } }))).toBe("unassigned Ana");
    expect(phraseHistory(history({ fromAssignee: { name: "A" }, toAssignee: { name: "B" } }))).toBe(
      "changed assignee from A to B",
    );
    expect(phraseHistory(history({ toParent: { identifier: "BACK-2" } }))).toBe(
      "set parent issue to BACK-2",
    );
    expect(phraseHistory(history({ fromParent: { identifier: "BACK-1" } }))).toBe(
      "removed parent issue",
    );
    expect(phraseHistory(history({ toDueDate: "2026-11-01" }))).toBe("set due date to 2026-11-01");
    expect(phraseHistory(history({ fromDueDate: "2026-11-01" }))).toBe("removed due date");
    expect(phraseHistory(history({ fromEstimate: 0, toEstimate: 3 }))).toBe(
      "changed estimate from 0 to 3",
    );
  });

  it("joins several changes in one entry", () => {
    expect(
      phraseHistory(
        history({
          fromTitle: "Old",
          toTitle: "New",
          addedLabels: [{ name: "Bug" }],
          removedLabels: [{ name: "Bug" }, { name: "Infra" }],
          toProject: { name: "Infra" },
          fromCycle: { number: 8 },
          toCycle: { number: 9 },
        }),
      ),
    ).toBe(
      "added label Bug, removed labels Bug, Infra, changed the title from Old to New, set project to Infra, changed cycle from 8 to 9",
    );
    expect(phraseHistory(history({ archived: true, autoClosed: true }))).toBe(
      "archived the issue, auto-closed the issue",
    );
  });
});
