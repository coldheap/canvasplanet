/**
 * Drop an image, quantize it to the palette, place it, commit it.
 *
 * Quantization happens here rather than on the server, which never decodes an
 * image at all — image parsing is a classic source of memory-exhaustion bugs
 * and there is no reason to expose the server to it. The route receives a
 * plain array of palette indices and validates them.
 *
 * The whole stamp commits under one batch id, so a misplaced 200×200 image is
 * a single revert rather than a cleanup job. Preview always runs first.
 */

import { useState } from "react";
import { AlertTriangle, Check, Image as ImageIcon, Stamp } from "lucide-react";
import { ADMIN_STAMP_MAX_DIM, PALETTE, nearestPaletteIndex } from "@canvasplanet/shared";
import { api, type StampResult } from "../../api.js";
import { pickBbox } from "../../canvas/pickBbox.js";
import type { MapHandle } from "../MapCanvas.js";

const TRANSPARENT = 255;

export function StampTab({ handle }: { handle: MapHandle | null }) {
  const [image, setImage] = useState<{ w: number; h: number; data: number[]; url: string } | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<StampResult | null>(null);
  const [autoProtect, setAutoProtect] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width > ADMIN_STAMP_MAX_DIM || bitmap.height > ADMIN_STAMP_MAX_DIM) {
        setError(`Image must be at most ${ADMIN_STAMP_MAX_DIM}×${ADMIN_STAMP_MAX_DIM} pixels.`);
        return;
      }
      setImage({ ...quantize(bitmap), url: URL.createObjectURL(file) });
    } catch {
      setError("Could not read that image.");
    } finally {
      setBusy(false);
    }
  }

  /** Pick the top-left corner by drawing a 1-pixel selection on the map. */
  async function place(): Promise<void> {
    if (!handle) return;
    const bbox = await pickBbox(handle);
    if (bbox) {
      setAt({ x: bbox.x0, y: bbox.y0 });
      setPreview(null);
    }
  }

  async function run(isPreview: boolean): Promise<void> {
    if (!image || !at) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.admin.stamp({
        x: at.x,
        y: at.y,
        w: image.w,
        h: image.h,
        data: image.data,
        preview: isPreview,
        autoProtect: isPreview ? false : autoProtect,
        name: name.trim() || undefined,
      });
      setPreview(result);
      if (!isPreview) {
        handle?.bbox.clear();
        handle?.refreshTiles();
      }
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "The stamp failed.");
    } finally {
      setBusy(false);
    }
  }

  const opaque = image ? image.data.filter((v) => v !== TRANSPARENT).length : 0;

  return (
    <section>
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
          <p className="cp-hint">{opaque.toLocaleString()} pixels will be painted.</p>

          <div className="cp-actions">
            <button className="cp-btn" disabled={!handle} onClick={() => void place()}>
              {at ? `Placed at ${at.x}, ${at.y}` : "Click map for top-left"}
            </button>
          </div>

          <label className="cp-toggle">
            <input
              type="checkbox"
              checked={autoProtect}
              onChange={(e) => setAutoProtect(e.target.checked)}
            />
            Protect this area after stamping
          </label>
          {autoProtect && (
            <input
              placeholder="Region name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          )}

          <div className="cp-actions">
            <button className="cp-btn" disabled={!at || busy} onClick={() => void run(true)}>
              Preview
            </button>
            <button
              className="cp-btn cp-btn-primary"
              // Preview first, always: a stamp is revertible but an
              // unexpected blast radius still ruins someone's afternoon.
              disabled={!preview?.preview || busy}
              onClick={() => void run(false)}
            >
              <Stamp size={15} />
              Commit
            </button>
          </div>
        </>
      )}

      {preview && (
        <div className="cp-stamp-result">
          <p>
            <strong>{preview.pixels.toLocaleString()}</strong> pixels{" "}
            {preview.preview ? "would be painted" : "painted"}
            {preview.batchId && <em className="cp-hint"> · batch {preview.batchId.slice(0, 8)}</em>}
          </p>
          {preview.violations > 0 && (
            <p className="cp-admin-alert">
              <AlertTriangle size={14} />
              {preview.violations.toLocaleString()} pixels use the wrong colour family for their
              terrain.
            </p>
          )}
          {preview.skippedProtected > 0 && (
            <p className="cp-admin-alert">
              <AlertTriangle size={14} />
              {preview.skippedProtected.toLocaleString()} pixels fall inside a protected region and
              will be skipped.
            </p>
          )}
          {!preview.preview && (
            <p className="cp-ok">
              <Check size={14} /> Committed.
            </p>
          )}
        </div>
      )}

      {error && <p className="cp-error">{error}</p>}
    </section>
  );
}

/** Render the quantized result at 1 pixel per pixel, scaled up by CSS. */
function QuantizedPreview({ w, h, data }: { w: number; h: number; data: number[] }) {
  return (
    <canvas
      width={w}
      height={h}
      className="cp-pixelated"
      ref={(el) => {
        if (!el) return;
        const ctx = el.getContext("2d");
        if (!ctx) return;
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < data.length; i++) {
          const idx = data[i]!;
          if (idx === TRANSPARENT) continue;
          const hex = PALETTE[idx]!.hex;
          img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
          img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
          img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
          img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      }}
    />
  );
}

function quantize(bitmap: ImageBitmap): { w: number; h: number; data: number[] } {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  const out = new Array<number>(bitmap.width * bitmap.height).fill(TRANSPARENT);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    // Anything meaningfully transparent stays unpainted rather than becoming
    // whatever colour happens to sit behind an alpha of 3.
    if (img.data[o + 3]! < 128) continue;
    out[i] = nearestPaletteIndex(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
  }
  return { w: bitmap.width, h: bitmap.height, data: out };
}
