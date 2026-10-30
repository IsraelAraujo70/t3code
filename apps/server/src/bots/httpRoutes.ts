/** The fork's plain HTTP routes, registered once beside the upstream routes in `server.ts`. */
import * as Layer from "effect/Layer";

import * as ComputerStream from "./computer/ComputerStream.ts";
import * as AppUpdate from "./appUpdate/AppUpdate.ts";
import * as VsCodeProxy from "./vscode/VsCodeProxy.ts";

export const routeLayer = Layer.mergeAll(
  ComputerStream.routeLayer,
  AppUpdate.routeLayer,
  VsCodeProxy.routeLayer,
);
