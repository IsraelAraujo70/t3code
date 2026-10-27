import { describe, expect, it } from "@effect/vitest";

import { linearFilterToClauses, type LinearFilterContext } from "./linearViewImport.ts";

const ctx: LinearFilterContext = {
  labelIdsByName: (name) => (name.toLowerCase() === "bug" ? ["l-bug", "l-bug-ui"] : []),
  statesByName: (name) => (name === "Todo" ? ["s-todo", "f-todo"] : []),
};

const imported = (filterData: unknown) => linearFilterToClauses(filterData, ctx);

describe("linearFilterToClauses", () => {
  it("imports the views Linear wrote for this workspace", () => {
    expect(imported({ and: [{ assignee: { or: [{ isMe: { eq: true } }] } }] })).toEqual({
      ok: true,
      filters: [{ kind: "set", field: "assignee", op: "in", values: ["me"] }],
    });
    expect(
      imported({
        and: [
          {
            labels: {
              and: [{ or: [{ name: { eq: "Bug" } }, { parent: { name: { eq: "Bug" } } }] }],
            },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      filters: [{ kind: "set", field: "label", op: "in", values: ["l-bug", "l-bug-ui"] }],
    });
    expect(imported({ and: [{ parent: { null: false } }] })).toEqual({
      ok: true,
      filters: [{ kind: "flag", field: "isSubIssue", value: true }],
    });
    expect(imported({ and: [{ children: { length: { gt: 0 } } }] })).toEqual({
      ok: true,
      filters: [{ kind: "flag", field: "hasSubIssues", value: true }],
    });
  });

  it.each([{}, { and: [] }])("imports an empty filter %j as no clauses", (filterData) => {
    expect(imported(filterData)).toEqual({ ok: true, filters: [] });
  });

  it("turns an or of one field into one clause with several values", () => {
    expect(
      imported({
        assignee: { or: [{ isMe: { eq: true } }, { null: true }, { id: { eq: "u-ana" } }] },
      }),
    ).toEqual({
      ok: true,
      filters: [{ kind: "set", field: "assignee", op: "in", values: ["me", "none", "u-ana"] }],
    });
  });

  it("imports status, priority, people, project, cycle and due date filters", () => {
    expect(
      imported({
        and: [
          { state: { type: { nin: ["completed", "canceled"] } } },
          { state: { name: { eq: "Todo" } } },
          { priority: { in: [1, 2] } },
          { creator: { id: { in: ["u-ana", "u-bia"] } } },
          { project: { id: { eq: "p-infra" } } },
          { cycle: { id: { eq: "c-9" } } },
          { dueDate: { null: true } },
          { parent: { null: true } },
        ],
      }),
    ).toEqual({
      ok: true,
      filters: [
        { kind: "set", field: "statusType", op: "notIn", values: ["completed", "canceled"] },
        { kind: "set", field: "status", op: "in", values: ["s-todo", "f-todo"] },
        { kind: "set", field: "priority", op: "in", values: ["1", "2"] },
        { kind: "set", field: "creator", op: "in", values: ["u-ana", "u-bia"] },
        { kind: "set", field: "project", op: "in", values: ["p-infra"] },
        { kind: "set", field: "cycle", op: "in", values: ["c-9"] },
        { kind: "flag", field: "hasDueDate", value: false },
        { kind: "flag", field: "isSubIssue", value: false },
      ],
    });
  });

  it("rejects the whole view when one clause is not supported", () => {
    expect(
      imported({
        and: [{ hasBlockedByRelations: { eq: true } }, { hasBlockingRelations: { eq: true } }],
      }),
    ).toEqual({ ok: false, reason: "hasBlockedByRelations: not supported in T3" });
    expect(
      imported({ and: [{ assignee: { isMe: { eq: true } } }, { estimate: { gt: 2 } }] }),
    ).toEqual({ ok: false, reason: "estimate: not supported in T3" });
  });

  it.each([
    [
      "an or across fields",
      { or: [{ priority: { eq: 1 } }, { assignee: { isMe: { eq: true } } }] },
    ],
    ["an or mixing is and is not", { assignee: { or: [{ null: false }, { isMe: { eq: true } }] } }],
    ["two comparisons at once", { assignee: { id: { eq: "a", in: ["b"] } } }],
    ["a comparison Linear has but T3 lacks", { title: { contains: "msk" } }],
    ["isMe false", { assignee: { isMe: { eq: false } } }],
    ["non-object filter data", null],
  ])("rejects %s", (_name, filterData) => {
    expect(imported(filterData)).toMatchObject({ ok: false });
  });

  it("rejects a label or status name T3 does not know", () => {
    expect(imported({ labels: { name: { eq: "Infra" } } })).toEqual({
      ok: false,
      reason: 'label "Infra": not found in T3',
    });
  });
});
