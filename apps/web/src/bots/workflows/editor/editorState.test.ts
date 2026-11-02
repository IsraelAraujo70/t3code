import * as Schema from "effect/Schema";
import { WorkflowId, WorkflowDocRevision } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { WorkflowDefinition, WorkflowDocument } from "@t3tools/contracts";
import { initialEditorState, reducer } from "./editorState";

const workflowId = Schema.decodeSync(WorkflowId)("demo");
const revision = Schema.decodeSync(WorkflowDocRevision);

const definition: WorkflowDefinition = {
  schema: "t3.workflow/v1",
  id: "demo",
  title: "Demo",
  home: { project: "demo" },
  budget: { steps: 10, wall: "1h", tokens: 1000 },
  fatigue: { consecutiveFailures: 3 },
  nodes: {},
  edges: [],
};
const doc: WorkflowDocument = {
  workflowId: workflowId,
  source: "",
  definition,
  revision: revision("a".repeat(40)),
  headCommit: null,
  hash: null,
  valid: true,
  dirty: false,
  diagnostics: [],
  enabled: true,
  suspended: false,
  updatedBy: null,
  updatedAt: null,
};
it("accepts remote documents without a draft and retains local edits otherwise", () => {
  const current = { ...doc, revision: revision("b".repeat(40)) };
  expect(
    reducer(initialEditorState(doc), { type: "documentArrived", document: current }).base,
  ).toEqual(current);
  const edited = reducer(initialEditorState(doc), { type: "edited", definition });
  expect(reducer(edited, { type: "documentArrived", document: doc })).toBe(edited);
  const changed = reducer(edited, { type: "documentArrived", document: current });
  expect(changed.base).toEqual(doc);
  expect(changed.remote).toEqual(current);
  expect(reducer(changed, { type: "saved" }).base).toEqual(current);
  expect(reducer(changed, { type: "reload" })).toEqual(initialEditorState(current));
});
it("merges independent changes and uses the remote revision for the next save", () => {
  const mine = { ...definition, title: "Mine" };
  const current = {
    ...doc,
    revision: revision("b".repeat(40)),
    definition: { ...definition, description: "Theirs" },
  };
  const state = reducer(reducer(initialEditorState(doc), { type: "edited", definition: mine }), {
    type: "conflictReturned",
    current,
  });
  const merged = reducer(state, { type: "merge" });
  expect(merged.draft).toMatchObject({ title: "Mine", description: "Theirs" });
  expect(merged.base.revision).toBe(current.revision);
  expect(merged.conflict).toBeNull();
  expect(reducer(merged, { type: "saved" }).draft).toBeNull();
});
it("overwrites an invalid remote file only after explicit resolution", () => {
  const current = { ...doc, revision: revision("b".repeat(40)), definition: null, valid: false };
  const edited = reducer(initialEditorState(doc), { type: "edited", definition });
  const conflict = reducer(edited, { type: "conflictReturned", current });
  expect(reducer(conflict, { type: "merge" })).toBe(conflict);
  const overwrite = reducer(conflict, { type: "overwrite" });
  expect(overwrite.base).toEqual(current);
  expect(overwrite.draft).toEqual(definition);
  expect(reducer(conflict, { type: "reload" })).toEqual(initialEditorState(current));
});

it("merges streamed changes and retains a note for overlapping edits until save", () => {
  const edited = reducer(initialEditorState(doc), {
    type: "edited",
    definition: { ...definition, title: "Mine" },
  });
  const current = {
    ...doc,
    revision: revision("c".repeat(40)),
    definition: { ...definition, title: "Theirs" },
  };
  const remote = reducer(edited, { type: "documentArrived", document: current });
  const merged = reducer(remote, { type: "merge" });
  expect(merged.draft?.title).toBe("Mine");
  expect(merged.mergedConflicts).toEqual(["title"]);
  expect(merged.remote).toBeNull();
  expect(merged.base).toEqual(current);
  const saved = reducer(merged, { type: "saved" });
  expect(saved.mergedConflicts).toEqual([]);
  expect(reducer(saved, { type: "documentArrived", document: current }).base).toEqual(current);
});

it("leaves merge without a usable base or draft unchanged and reloads the base", () => {
  const initial = initialEditorState(doc);
  expect(reducer(initial, { type: "merge" })).toBe(initial);
  expect(reducer(initial, { type: "reload" })).toEqual(initial);
  expect(reducer(initial, { type: "overwrite" }).base).toEqual(doc);
  const invalid = initialEditorState({ ...doc, definition: null });
  const conflict = reducer(reducer(invalid, { type: "edited", definition }), {
    type: "conflictReturned",
    current: doc,
  });
  expect(reducer(conflict, { type: "merge" })).toBe(conflict);
});
