import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import "./seo.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Country flags are used only after the canvas UI is interactive (panels and
// pixel inspection). Their all-country stylesheet is much larger than the
// startup shell, so fetch it during idle time instead of blocking first paint.
const loadFlagStyles = () => void import("flag-icons/css/flag-icons.min.css");
const idleWindow = window as Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};
if (idleWindow.requestIdleCallback) {
  idleWindow.requestIdleCallback(loadFlagStyles, { timeout: 1_500 });
} else {
  window.setTimeout(loadFlagStyles, 0);
}
