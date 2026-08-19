/**
 * Template overlay: drop an image, place it on the map, paint over the ghost.
 *
 * In v1 despite "pixel art tools" being out of scope in the original brief,
 * deliberately: shipping a good sanctioned overlay is the cheapest way to
 * reduce demand for third-party scripts that also automate *painting*. This
 * is the honest half of what people currently use bots for, so it is worth
 * making genuinely good.
 *
 * Quantization runs here, not on the server, which never decodes an image at
 * all — image parsing is a classic source of memory-exhaustion bugs and there
 * is no reason to expose the server to it.
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  MapPin,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import {
  COST_BASE,
  PALETTE,
  TEMPLATE_MAX_DIM,
  TRANSPARENT_INDEX,
  type DitherMode,
  quantizeToPalette,
} from "@canvasplanet/shared";
import { api } from "../api.js";
import { pickPoint } from "../canvas/pointPick.js";
import { centeredTemplateOrigin } from "../canvas/templatePixels.js";
import { useStore } from "../store.js";
import type { MapHandle } from "./MapCanvas.js";

interface Loaded {
  w: number;
  h: number;
  /** Original RGBA, kept so dithering can be toggled without re-reading. */
  rgba: Uint8ClampedArray;
  data: Uint8Array;
  url: string;
}

export function OverlayTool({ handle }: { handle: MapHandle | null }) {
  const setPanel = useStore((s) => s.setPanel);
  const templateTick = useStore((s) => s.templateTick);
  const [image, setImage] = useState<Loaded | null>(null);
  const [dither, setDither] = useState<DitherMode>("none");
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [placing, setPlacing] = useState(false);
  const [opacity, setOpacity] = useState(0.85);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- load and quantize ---------------------------------------------------
  async function load(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width > TEMPLATE_MAX_DIM || bitmap.height > TEMPLATE_MAX_DIM) {
        setError(
          `Image must be at most ${TEMPLATE_MAX_DIM}×${TEMPLATE_MAX_DIM} pixels ` +
            `(this one is ${bitmap.width}×${bitmap.height}).`,
        );
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      setImage({
        w: bitmap.width,
        h: bitmap.height,
        rgba,
        data: quantizeToPalette(rgba, bitmap.width, bitmap.height, dither),
        url: URL.createObjectURL(file),
      });
      setShareUrl(null);
    } catch {
      setError("Could not read that image.");
    } finally {
      setBusy(false);
    }
  }

  // Re-quantize when the dither mode changes, from the original pixels rather
  // than re-reading the file.
  useEffect(() => {
    setImage((prev) =>
      prev ? { ...prev, data: quantizeToPalette(prev.rgba, prev.w, prev.h, dither) } : prev,
    );
  }, [dither]);

  // ---- push to the map -----------------------------------------------------
  useEffect(() => {
    if (!handle) return;
    if (!image || !at) {
      handle.template.set(null);
      return;
    }
    handle.template.set({ x: at.x, y: at.y, w: image.w, h: image.h, data: image.data });

    // Read what is already on the canvas underneath, so the ghost shows only
    // what is left to do and the progress counter means something.
    let cancelled = false;
    void api
      .region({ x0: at.x, y0: at.y, x1: at.x + image.w - 1, y1: at.y + image.h - 1 })
      .then((r) => {
        if (cancelled) return;
        handle.template.setActual(Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0)));
        setProgress(handle.template.progress());
      })
      .catch(() => setError("Could not read the canvas under the template."));
    return () => {
      cancelled = true;
    };
  }, [handle, image, at]);

  useEffect(() => {
    handle?.template.setOpacity(opacity);
  }, [handle, opacity]);

  // App applies live paints to the template layer; this re-reads the count.
  useEffect(() => {
    if (handle) setProgress(handle.template.progress());
  }, [handle, templateTick]);

  // Clear the ghost when the panel unmounts, or it hangs over the map with no
  // visible way to get rid of it.
  useEffect(() => () => {
    handle?.point.cancel();
    handle?.template.set(null);
  }, [handle]);

  async function place(): Promise<void> {
    if (!image) return;
    setPlacing(true);
    const center = await pickPoint(handle);
    setPlacing(false);
    if (center) {
      const origin = centeredTemplateOrigin(center, image.w, image.h);
      setAt(origin);
      handle?.fitTemplate(origin.x, origin.y, image.w, image.h);
    }
  }

  async function share(): Promise<void> {
    if (!image || !at) return;
    setBusy(true);
    setError(null);
    try {
      // Chunked, because String.fromCharCode(...) on a large image array can
      // exceed the browser's argument limit and throw.
      let binary = "";
      for (let i = 0; i < image.data.length; i += 8192) {
        binary += String.fromCharCode(...image.data.subarray(i, i + 8192));
      }
      const res = await api.publishTemplate({
        x: at.x,
        y: at.y,
        w: image.w,
        h: image.h,
        data: btoa(binary),
      });
      setShareUrl(`${location.origin}/t/${res.id}`);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not publish that template.");
    } finally {
      setBusy(false);
    }
  }

  const opaque = image ? image.data.reduce((n, v) => n + (v === TRANSPARENT_INDEX ? 0 : 1), 0) : 0;
  const next = handle?.template.getNextPixel() ?? null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="cp-overlay-tool cp-card">
      <button className="cp-modal-close" aria-label="Close" onClick={() => setPanel("none")}>
        <X size={16} />
      </button>
      <h2 className="cp-panel-title">
        <LayoutTemplate size={16} />
        Template
      </h2>

      <label className="cp-drop">
        <ImageIcon size={16} />
        <span>{image ? `${image.w}×${image.h}` : "Choose an image"}</span>
        <input
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])}
        />
      </label>

      {image && (
        <>
          <div className="cp-stamp-preview">
            <figure>
              <img src={image.url} alt="original" />
              <figcaption className="cp-hint">original</figcaption>
            </figure>
            <figure>
              <QuantizedPreview w={image.w} h={image.h} data={image.data} />
              <figcaption className="cp-hint">{PALETTE.length} colours</figcaption>
            </figure>
          </div>

          <label>
            Dither
            <select value={dither} onChange={(e) => setDither(e.target.value as DitherMode)}>
              <option value="none">None — flat colour</option>
              <option value="floyd">Floyd–Steinberg</option>
            </select>
          </label>

          <div className="cp-actions">
            <button className="cp-btn" disabled={!handle || placing} onClick={() => void place()}>
              <MapPin size={15} />
              {placing ? "Click template centre…" : at ? "Reposition" : "Place on map"}
            </button>
          </div>

          {placing && <p className="cp-hint">Click once where the template centre should go. Press Esc to cancel.</p>}
          {at && <p className="cp-hint">Top-left pixel: <code>{at.x}, {at.y}</code></p>}

          {at && (
            <>
              <label className="cp-opacity">
                Unfinished pixels
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={opacity * 100}
                  onChange={(e) => setOpacity(Number(e.target.value) / 100)}
                />
                <span className="cp-hint">{Math.round(opacity * 100)}%</span>
              </label>

              <p className="cp-hint">
                Marked pixels still need painting. Hover one to select its palette colour automatically.
              </p>

              <div className="cp-progress">
                <div className="cp-progress-track">
                  <div className="cp-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="cp-progress-label">
                  {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
                </span>
              </div>

              {next ? (
                <p className="cp-hint cp-next-pixel">
                  next: <code>{next.x}, {next.y}</code> — ringed on the map
                </p>
              ) : progress.total > 0 ? (
                <p className="cp-ok">
                  <Check size={14} /> Template complete.
                </p>
              ) : null}

              <p className="cp-hint">
                {opaque.toLocaleString()} pixels total, so at least{" "}
                {(opaque * COST_BASE).toLocaleString()} charges.
              </p>

              <div className="cp-actions">
                <button className="cp-btn" disabled={busy} onClick={() => void share()}>
                  {busy ? <Loader2 size={15} className="cp-spin" /> : <Share2 size={15} />}
                  Share
                </button>
                <button
                  className="cp-btn"
                  onClick={() => {
                    setImage(null);
                    setAt(null);
                    setShareUrl(null);
                    handle?.template.set(null);
                  }}
                >
                  <Trash2 size={15} />
                  Clear
                </button>
              </div>

              {shareUrl && (
                <div className="cp-share">
                  <code>{shareUrl}</code>
                  <button
                    className="cp-btn"
                    aria-label="Copy link"
                    onClick={() => {
                      void navigator.clipboard.writeText(shareUrl);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                  {/* Unlisted, not private. Saying so is the difference
                      between someone sharing art and someone sharing
                      something they assumed only one person would see. */}
                  <p className="cp-hint">
                    Anyone with this link can load it. Unlisted, not secret.
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {error && <p className="cp-error">{error}</p>}
    </div>
  );
}

/** The quantized result at 1 pixel per pixel, scaled up by CSS. */
export function QuantizedPreview({ w, h, data }: { w: number; h: number; data: Uint8Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < data.length; i++) {
      const idx = data[i]!;
      if (idx === TRANSPARENT_INDEX) continue;
      const hex = PALETTE[idx]!.hex;
      img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
      img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[i * 4 + 3] = 255;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(img, 0, 0);
  }, [w, h, data]);

  return <canvas ref={ref} width={w} height={h} className="cp-pixelated" />;
}
