/**
 * "Get embed code" — draw a region, get an `<iframe>` snippet for it
 * (ROADMAP.md §4.2). The widget it points at (embed.html/EmbedApp.tsx) is a
 * separate bundle; this panel's only job is picking the region and building
 * the URL, the same draw-then-generate shape as ReportTool/TimelapsePanel.
 */

import { useState } from "react";
import { Check, Code2, Copy, Square, X } from "lucide-react";
import { pickBbox } from "../canvas/pickBbox.js";
import { useStore } from "../store.js";
import type { MapHandle } from "./MapCanvas.js";

type Bbox = { x0: number; y0: number; x1: number; y1: number };

export function EmbedTool({ handle }: { handle: MapHandle | null }) {
  const setPanel = useStore((s) => s.setPanel);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [width, setWidth] = useState(480);
  const [height, setHeight] = useState(360);
  const [copied, setCopied] = useState(false);

  function clear(): void {
    handle?.bbox.clear();
    setBbox(null);
    setCopied(false);
  }

  const src = bbox
    ? `${location.origin}/embed.html?x0=${bbox.x0}&y0=${bbox.y0}&x1=${bbox.x1}&y1=${bbox.y1}`
    : null;

  const snippet = src
    ? `<iframe src="${src}" width="${width}" height="${height}" style="border:0" loading="lazy" title="Worldcanvas — live"></iframe>`
    : "";

  return (
    <div className="wc-embed-tool wc-card">
      <button className="wc-modal-close" aria-label="Close" onClick={() => setPanel("none")}>
        <X size={16} />
      </button>
      <h2 className="wc-panel-title">
        <Code2 size={16} />
        Embed
      </h2>

      <p className="wc-hint">
        Draw a region to get a live, read-only <code>&lt;iframe&gt;</code> for your own site — no
        painting from it, just the canvas updating in real time.
      </p>

      <div className="wc-actions">
        <button className="wc-btn" disabled={!handle} onClick={async () => {
          const b = await pickBbox(handle);
          if (b) setBbox(b);
        }}>
          <Square size={15} />
          {bbox ? "Redraw region" : "Draw region on map"}
        </button>
        {bbox && (
          <button className="wc-btn" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      {bbox && (
        <>
          <p className="wc-hint">
            <code>
              {bbox.x0},{bbox.y0} → {bbox.x1},{bbox.y1}
            </code>
          </p>

          <div className="wc-embed-preview">
            <iframe src={src!} title="Embed preview" />
          </div>

          <label className="wc-embed-size">
            Size
            <input
              type="number"
              min={120}
              max={2000}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value) || 480)}
            />
            ×
            <input
              type="number"
              min={90}
              max={2000}
              value={height}
              onChange={(e) => setHeight(Number(e.target.value) || 360)}
            />
            <span className="wc-hint">pixels</span>
          </label>

          <div className="wc-embed-code">
            <textarea readOnly rows={3} value={snippet} onFocus={(e) => e.target.select()} />
          </div>

          <div className="wc-actions">
            <button
              className="wc-btn wc-btn-primary"
              onClick={() => {
                void navigator.clipboard.writeText(snippet);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy embed code"}
            </button>
          </div>

          <p className="wc-hint">
            Live view: painting updates arrive the same way they do here. Nothing painted from the
            embed itself — it only ever reads.
          </p>
        </>
      )}
    </div>
  );
}
