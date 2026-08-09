import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { EmbedApp } from "./EmbedApp.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EmbedApp />
  </StrictMode>,
);
