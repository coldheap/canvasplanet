import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import "./seo.css";
import { startBootstrap } from "./api.js";
import { App } from "./App.js";

// Before the first render, not after it: see startBootstrap's comment. The
// round trip then overlaps React's mount and Leaflet's map construction
// instead of queueing behind them.
startBootstrap();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
