import { useState } from "react";
import { Clapperboard, Code2, Flag, LayoutTemplate, X } from "lucide-react";
import { useStore } from "../store.js";
import type { MapHandle } from "./MapCanvas.js";
import { EmbedTool } from "./EmbedTool.js";
import { OverlayTool } from "./OverlayTool.js";
import { ReportTool } from "./ReportTool.js";
import { TimelapsePanel } from "./TimelapsePanel.js";

type Tool = "template" | "timelapse" | "embed" | "report";

const TOOLS: Array<{ id: Tool; label: string; icon: typeof LayoutTemplate }> = [
  { id: "template", label: "Template", icon: LayoutTemplate },
  { id: "timelapse", label: "Timelapse", icon: Clapperboard },
  { id: "embed", label: "Embed", icon: Code2 },
  { id: "report", label: "Report", icon: Flag },
];

export function CanvasToolsPanel({ handle }: { handle: MapHandle | null }) {
  const setPanel = useStore((state) => state.setPanel);
  const [tool, setTool] = useState<Tool>("template");

  function moveTab(current: Tool, direction: -1 | 1): void {
    const index = TOOLS.findIndex(({ id }) => id === current);
    const next = TOOLS[(index + direction + TOOLS.length) % TOOLS.length]!.id;
    setTool(next);
    document.getElementById(`cp-tool-tab-${next}`)?.focus();
  }

  return (
    <aside className="cp-tools-panel cp-card" aria-labelledby="cp-tools-title">
      <header className="cp-tools-head">
        <h2 id="cp-tools-title">Canvas tools</h2>
        <button className="cp-panel-icon-btn" aria-label="Close canvas tools" onClick={() => setPanel("none")}>
          <X size={17} />
        </button>
      </header>

      <div className="cp-tools-tabs" role="tablist" aria-label="Canvas tool">
        {TOOLS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            id={`cp-tool-tab-${id}`}
            role="tab"
            aria-selected={tool === id}
            aria-controls={`cp-tool-pane-${id}`}
            aria-label={label}
            title={label}
            tabIndex={tool === id ? 0 : -1}
            onClick={() => setTool(id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                moveTab(id, -1);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                moveTab(id, 1);
              }
            }}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>

      <div className="cp-tools-scroll">
        <div id="cp-tool-pane-template" className="cp-tool-pane" role="tabpanel" aria-labelledby="cp-tool-tab-template" hidden={tool !== "template"}>
          <OverlayTool handle={handle} />
        </div>
        <div id="cp-tool-pane-timelapse" className="cp-tool-pane" role="tabpanel" aria-labelledby="cp-tool-tab-timelapse" hidden={tool !== "timelapse"}>
          <TimelapsePanel handle={handle} />
        </div>
        <div id="cp-tool-pane-embed" className="cp-tool-pane" role="tabpanel" aria-labelledby="cp-tool-tab-embed" hidden={tool !== "embed"}>
          <EmbedTool handle={handle} />
        </div>
        <div id="cp-tool-pane-report" className="cp-tool-pane" role="tabpanel" aria-labelledby="cp-tool-tab-report" hidden={tool !== "report"}>
          <ReportTool handle={handle} />
        </div>
      </div>
    </aside>
  );
}
