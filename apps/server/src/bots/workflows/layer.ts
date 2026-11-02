// @effect-diagnostics nodeBuiltinImport:off - resolves the run directory and the unit runner's path.
/**
 * The workflow engine on the bots host: journal, catalog over the definitions repository, and the
 * host interpreter with its executors. bots.sqlite's SqlClient stays private to this block.
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import * as BotsDb from "../BotsDb.ts";
import * as Catalog from "./definitions/catalog.ts";
import * as Definitions from "./definitions/WorkflowDefinitions.ts";
import * as HostInterpreter from "./exec/HostInterpreter.ts";
import * as Turns from "./exec/Turns.ts";
import * as Units from "./exec/Units.ts";
import * as Workspaces from "./git/Workspaces.ts";
import * as Journal from "./Journal.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const runsDir = NodePath.join(config.baseDir, "workflows", "runs");
    const env = process.env;
    const executors = Layer.mergeAll(
      Turns.layer({
        instances: {
          claude: env.T3CODE_WORKFLOW_CLAUDE_INSTANCE,
          codex: env.T3CODE_WORKFLOW_CODEX_INSTANCE,
        },
      }),
      Units.layer({
        node: process.execPath,
        // Runs from source like the server itself: production starts `node apps/server/src/bin.ts`.
        wfUnitPath: NodePath.join(import.meta.dirname, "exec", "wfUnit.ts"),
        heavyLock:
          env.T3CODE_WORKFLOW_HEAVY_LOCK ??
          NodePath.join(env.HOME ?? "", ".cache", "t3-testdata", "heavy.lock"),
        run: Units.defaultRun,
      }),
    ).pipe(Layer.provideMerge(Workspaces.layer));
    return WorkflowEngine.layer({ runsDir }).pipe(
      Layer.provide(HostInterpreter.layer({ runsDir }).pipe(Layer.provide(executors))),
      Layer.provideMerge(Catalog.layer),
      Layer.provideMerge(Definitions.layer),
      Layer.provideMerge(Journal.layerFromDb),
      Layer.provide(BotsDb.layer),
    );
  }),
);
