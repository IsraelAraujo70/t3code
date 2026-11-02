import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { layer, WorkflowRepo, workflowFileName } from "./WorkflowRepo.ts";

it.live("maintains isolated workflow history and disk changes with real git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const repo = yield* WorkflowRepo;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (args: string[]) =>
          spawner.string(ChildProcess.make("git", args, { cwd: root }));
        yield* repo.ensure;
        yield* repo.ensure;
        expect((yield* git(["rev-list", "--count", "HEAD"])).trim()).toBe("1");
        expect(yield* repo.read("a")).toEqual(Option.none());
        yield* repo.writeAtomic("a", "first é\n");
        expect(repo.revisionOf("first é\n")).toBe(
          (yield* git(["hash-object", workflowFileName("a")])).trim(),
        );
        const input = { workflowId: "a", author: "Israel", message: "First\n\nBody" };
        const first = yield* repo.commit(input);
        expect(yield* repo.commit(input)).toBe(first);
        expect(Option.getOrThrow(yield* repo.head("a"))).toMatchObject({
          commit: first,
          author: "Israel",
          revision: repo.revisionOf("first é\n"),
          message: input.message,
        });
        yield* repo.writeAtomic("b", "other");
        yield* repo.writeAtomic("a", "second");
        const second = yield* repo.commit({ ...input, message: "Second" });
        expect(yield* repo.dirtyIds).toEqual(["b"]);
        expect(yield* repo.show("b", second)).toEqual(Option.none());
        expect(yield* repo.show("a", first)).toEqual(Option.some("first é\n"));
        expect((yield* repo.log("a", { skip: 0, limit: 1 })).map((entry) => entry.commit)).toEqual([
          second,
        ]);
        expect(
          (yield* repo.log("a", { skip: 1, limit: 1 })).map((entry) => entry.revision),
        ).toEqual([repo.revisionOf("first é\n")]);
        yield* fs.writeFileString(`${root}/a.workflow.yaml`, "manual");
        expect(yield* repo.dirtyIds).toEqual(["a", "b"]);
        yield* fs.remove(`${root}/a.workflow.yaml`);
        expect(yield* repo.dirtyIds).toEqual(["a", "b"]);
        yield* repo.remove({ ...input, message: "Remove" });
        expect(yield* repo.head("a")).toEqual(Option.none());
        expect(yield* repo.deleted).toMatchObject([{ workflowId: "a", commit: second }]);
        expect((yield* repo.log("a", { skip: 0, limit: 10 })).map((entry) => entry.commit)).toEqual(
          [second, first],
        );
        const backup = yield* repo.keepOverwritten("a", "backup");
        expect(yield* fs.readFileString(backup)).toBe("backup");
        expect(yield* git(["status", "--porcelain", "--untracked-files=all"])).not.toContain(
          ".overwritten",
        );
        expect(yield* repo.listIds).toEqual(["b"]);
      }).pipe(Effect.provide(layer(root)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
