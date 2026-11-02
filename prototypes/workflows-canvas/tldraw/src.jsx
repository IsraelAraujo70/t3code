import React, { lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "../shared/App";
const Canvas = lazy(() => import("./Canvas"));
createRoot(document.getElementById("root")).render(<App Canvas={Canvas} name="tldraw" />);
