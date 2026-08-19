/**
 * Watch an area paint itself from empty to now.
 *
 * Everything runs client-side: the server returns the events bucketed into
 * frames, and playback is a canvas replaying deltas. No encoding, no job
 * queue, no disk — which is why this ships and MP4 export does not (a
 * 512x512x200-frame encode is 2-10s of one core, and unbounded concurrency
 * would starve the paint path on a single box).
 *
 * Scrubbing backwards rebuilds from the base state rather than trying to
 * invert deltas, which would need the previous colour of every pixel in every
 * frame.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, Download, Loader2, Pause, Play, Square, X } from "lucide-react";
import {
  DEFAULT_TERRAIN_COLOR,
  PALETTE_RGB,
  TIMELAPSE_MAX_DIM,
  type ExportStatusResponse,
  type Terrain,
  type TimelapseResponse,
} from "@canvasplanet/shared";
import { api } from "../api.js";
import { pickBbox, type Bbox } from "../canvas/pickBbox.js";
import { useStore } from "../store.js";
import type { MapHandle } from "./MapCanvas.js";

const RANGES: Array<[string, number]> = [
  ["Last hour", 3600_000],
  ["Last 24 hours", 86_400_000],
  ["Last 7 days", 7 * 86_400_000],
  ["Last 30 days", 30 * 86_400_000],
];

/** Nothing is painted here. 255 is the same sentinel the template tools use. */
const EMPTY = 255;

/** Unpack `TimelapseResponse.terrain` into one `Terrain` value per pixel. */
function decodeTerrain(base64: string, n: number): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
  }
  return out;
}

export function TimelapsePanel({ handle }: { handle: MapHandle | null }) {
  const setPanel = useStore((s) => s.setPanel);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [rangeMs, setRangeMs] = useState(RANGES[1]![1]);
  const [data, setData] = useState<TimelapseResponse | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [format, setFormat] = useState<"gif" | "mp4">("gif");
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatusResponse | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Palette index per pixel for the current frame; EMPTY where unpainted. */
  const state = useRef<Uint8Array>(new Uint8Array(0));
  /** Which frame `state` currently represents, so forward scrubs are incremental. */
  const stateAt = useRef(-1);
  /** Terrain per pixel, so unpainted cells draw as sea/land instead of transparent. */
  const terrain = useRef<Uint8Array>(new Uint8Array(0));

  // The picker owns an imperative Leaflet rectangle, so remove it when this
  // panel closes. This also cancels a selection that is still in progress.
  useEffect(() => {
    return () => {
      handle?.bbox.cancel();
      handle?.bbox.clear();
    };
  }, [handle]);

  const width = bbox ? bbox.x1 - bbox.x0 + 1 : 0;
  const height = bbox ? bbox.y1 - bbox.y0 + 1 : 0;

  // ---- painting the canvas -------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = ctx.createImageData(width, height);
    for (let i = 0; i < state.current.length; i++) {
      const idx = state.current[i]!;
      // Unpainted: fall back to the pixel's terrain (sea/land) rather than
      // leaving it transparent, so an empty area reads as a place, not a hole.
      const rgb = idx === EMPTY ? PALETTE_RGB[DEFAULT_TERRAIN_COLOR[terrain.current[i] as Terrain]] : PALETTE_RGB[idx];
      if (!rgb) continue;
      img.data[i * 4] = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    ctx.clearRect(0, 0, width, height);
    ctx.putImageData(img, 0, 0);
  }, [data, width, height]);

  /** Bring `state` to the given frame, rebuilding from base if scrubbing back. */
  const seek = useCallback(
    (target: number) => {
      if (!data) return;
      if (target < stateAt.current) {
        state.current.fill(EMPTY);
        for (const [x, y, c] of data.base) {
          state.current[(y - data.bbox.y0) * width + (x - data.bbox.x0)] = c;
        }
        stateAt.current = -1;
      }
      for (let f = stateAt.current + 1; f <= target; f++) {
        for (const [x, y, c] of data.frames[f]!.p) {
          state.current[(y - data.bbox.y0) * width + (x - data.bbox.x0)] = c;
        }
      }
      stateAt.current = target;
      draw();
    },
    [data, width, draw],
  );

  useEffect(() => {
    if (data) seek(frame);
  }, [frame, data, seek]);

  // ---- playback ------------------------------------------------------------
  useEffect(() => {
    if (!playing || !data) return;
    const id = window.setInterval(() => {
      setFrame((f) => {
        if (f >= data.frames.length - 1) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, 100 / speed);
    return () => window.clearInterval(id);
  }, [playing, data, speed]);

  // ---- loading -------------------------------------------------------------
  async function selectArea(): Promise<void> {
    const b = await pickBbox(handle);
    if (!b) return;
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    if (w > TIMELAPSE_MAX_DIM || h > TIMELAPSE_MAX_DIM) {
      setError(`Area must be at most ${TIMELAPSE_MAX_DIM} pixels per side (you drew ${w}×${h}).`);
      setBbox(null);
      return;
    }
    setError(null);
    setBbox(b);
    setData(null);
  }

  async function load(): Promise<void> {
    if (!bbox) return;
    setBusy(true);
    setError(null);
    setPlaying(false);
    try {
      const to = Date.now();
      const res = await api.timelapse({ ...bbox, from: to - rangeMs, to, frames: 120 });
      state.current = new Uint8Array(width * height).fill(EMPTY);
      terrain.current = decodeTerrain(res.terrain, width * height);
      stateAt.current = -1;
      setData(res);
      setFrame(0);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not load that timelapse.");
    } finally {
      setBusy(false);
    }
  }

  // ---- export ----------------------------------------------------------
  // Exports the exact clip that's loaded (data.bbox/from/to/frames), not a
  // freshly re-queried "now" — what gets downloaded should match what was
  // just watched.
  async function startExport(): Promise<void> {
    if (!data) return;
    setExportBusy(true);
    setExportError(null);
    setExportStatus(null);
    setExportId(null);
    try {
      const res = await api.exportTimelapse({
        ...data.bbox,
        from: data.from,
        to: data.to,
        frames: data.frames.length,
        format,
      });
      setExportId(res.id);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setExportError(body?.error ?? "Could not start export.");
      setExportBusy(false);
    }
  }

  useEffect(() => {
    if (!exportId) return;
    let cancelled = false;
    let timeoutId: number | undefined;

    const poll = async () => {
      try {
        const s = await api.exportStatus(exportId);
        if (cancelled) return;
        setExportStatus(s);
        if (s.status === "queued" || s.status === "processing") {
          timeoutId = window.setTimeout(() => void poll(), 1500);
        } else {
          setExportBusy(false);
        }
      } catch {
        if (!cancelled) {
          setExportError("Lost track of the export.");
          setExportBusy(false);
        }
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [exportId]);

  const painted = data ? data.frames.reduce((n, f) => n + f.p.length, 0) : 0;

  return (
    <div className="cp-timelapse cp-card">
      <button className="cp-modal-close" aria-label="Close" onClick={() => setPanel("none")}>
        <X size={16} />
      </button>
      <h2 className="cp-panel-title">
        <Clapperboard size={16} />
        Timelapse
      </h2>

      <div className="cp-actions">
        <button className="cp-btn" disabled={!handle} onClick={() => void selectArea()}>
          <Square size={15} />
          {bbox ? `${width}×${height}` : "Draw an area"}
        </button>
        <select value={rangeMs} onChange={(e) => setRangeMs(Number(e.target.value))}>
          {RANGES.map(([label, ms]) => (
            <option key={label} value={ms}>
              {label}
            </option>
          ))}
        </select>
        <button className="cp-btn cp-btn-primary" disabled={!bbox || busy} onClick={() => void load()}>
          {busy ? <Loader2 size={15} className="cp-spin" /> : null}
          Load
        </button>
      </div>

      {error && <p className="cp-error">{error}</p>}

      {data && (
        <>
          <div className="cp-timelapse-stage">
            <canvas
              ref={canvasRef}
              width={width}
              height={height}
              className="cp-pixelated"
              style={{ aspectRatio: `${width} / ${height}` }}
            />
          </div>

          <div className="cp-timelapse-controls">
            <button
              className="cp-btn"
              onClick={() => {
                // Restarting from the end is what people expect from a
                // play button sitting at the end of a finished clip.
                if (!playing && frame >= data.frames.length - 1) setFrame(0);
                setPlaying((p) => !p);
              }}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>

            <input
              type="range"
              min={0}
              max={data.frames.length - 1}
              value={frame}
              onChange={(e) => {
                setPlaying(false);
                setFrame(Number(e.target.value));
              }}
            />

            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {[0.5, 1, 2, 4].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </div>

          <p className="cp-hint cp-timelapse-meta">
            {new Date(data.frames[frame]!.t).toLocaleString()} · frame {frame + 1}/
            {data.frames.length} · {painted.toLocaleString()} paints
            {data.truncated && (
              // Saying so beats showing a partial story as if it were whole.
              <strong className="cp-warn-text"> · truncated, narrow the range</strong>
            )}
          </p>
          {painted === 0 && (
            <p className="cp-hint">Nothing was painted here in that period.</p>
          )}

          <div className="cp-timelapse-export">
            <select value={format} onChange={(e) => setFormat(e.target.value as "gif" | "mp4")}>
              <option value="gif">GIF</option>
              <option value="mp4">MP4</option>
            </select>
            <button className="cp-btn" disabled={exportBusy} onClick={() => void startExport()}>
              {exportBusy ? <Loader2 size={15} className="cp-spin" /> : <Download size={15} />}
              Export
            </button>
            {exportStatus?.status === "done" && exportStatus.url && (
              <a className="cp-btn cp-btn-primary" href={exportStatus.url} download>
                <Download size={15} />
                Download {format.toUpperCase()}
              </a>
            )}
            {(exportStatus?.status === "queued" || exportStatus?.status === "processing") && (
              <span className="cp-hint">{exportStatus.status}…</span>
            )}
          </div>
          {(exportError || exportStatus?.status === "failed") && (
            <p className="cp-error">{exportError ?? exportStatus?.error ?? "Export failed."}</p>
          )}
        </>
      )}
    </div>
  );
}
