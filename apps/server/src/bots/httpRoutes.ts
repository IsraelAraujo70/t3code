/** The fork's plain HTTP routes, registered once beside the upstream routes in `server.ts`. */
import * as Layer from "effect/Layer";

import * as ComputerStream from "./computer/ComputerStream.ts";
import * as MobileUpdate from "./mobileUpdate/MobileUpdate.ts";

export const routeLayer = Layer.mergeAll(ComputerStream.routeLayer, MobileUpdate.routeLayer);
