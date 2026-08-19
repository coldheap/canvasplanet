/**
 * Colour picker.
 *
 * Below MIN_PAINT_ZOOM the whole thing collapses to a "Zoom in to paint" hint — a click
 * below the native grid zoom covers multiple pixels and would waste charges
 * on a guess, so the UI refuses rather than letting people misfire.
 */

import { useEffect, useState } from "react";
import { ChevronUp, MapPinOff } from "lucide-react";
import {
  BASEMAP_LAND_COLOR_INDEX,
  BASEMAP_WATER_COLOR_INDEX,
  Family,
  MIN_PAINT_ZOOM,
  PALETTE,
} from "@canvasplanet/shared";
import { useStore } from "../store.js";

const LAND_SWATCHES = [
  PALETTE[BASEMAP_LAND_COLOR_INDEX]!,
  ...PALETTE.filter((s) => s.family === Family.Land && s.i !== BASEMAP_LAND_COLOR_INDEX),
];

const WATER_SWATCHES = [
  PALETTE[BASEMAP_WATER_COLOR_INDEX]!,
  ...PALETTE.filter((s) => s.family === Family.Water && s.i !== BASEMAP_WATER_COLOR_INDEX),
];

const DISPLAY_SWATCHES = [...LAND_SWATCHES, ...WATER_SWATCHES];

export function PalettePanel({ zoom, onZoomToPaint }: { zoom: number; onZoomToPaint: () => void }) {
  const { selectedColor, select } = useStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectedSwatch = PALETTE[selectedColor] ?? PALETTE[0]!;

  // 1-9, 0 pick the original first 10 swatches (the neutrals/reds — the rest
  // of the palette stays click-only). Ignored while typing anywhere else
  // in the app, and while zoomed out too far to paint at all.
  useEffect(() => {
    if (zoom < MIN_PAINT_ZOOM) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key < "0" || e.key > "9") return;
      const idx = (Number(e.key) + 9) % 10; // "1".."9" -> 0..8, "0" -> 9
      if (idx < PALETTE.length) select(idx);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoom, select]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  useEffect(() => {
    if (zoom < MIN_PAINT_ZOOM) setMobileOpen(false);
  }, [zoom]);

  if (zoom < MIN_PAINT_ZOOM) {
    return (
      <button type="button" className="cp-palette cp-palette-locked cp-card" onClick={onZoomToPaint}>
        <MapPinOff size={16} aria-hidden />
        <span>Zoom in to paint</span>
      </button>
    );
  }

  return (
    <div className={mobileOpen ? "cp-palette cp-palette-open" : "cp-palette"}>
      <div className="cp-swatches cp-palette-grid cp-card" id="paint-colors">
        <div className="cp-swatch-group">
          {DISPLAY_SWATCHES.map((s) => (
            <Swatch
              key={s.i}
              i={s.i}
              hex={s.hex}
              name={s.name}
              on={s.i === selectedColor}
              pick={(i) => {
                select(i);
                setMobileOpen(false);
              }}
            />
          ))}
        </div>
      </div>
      <button
        type="button"
        className="cp-palette-trigger cp-card"
        aria-controls="paint-colors"
        aria-expanded={mobileOpen}
        aria-label={`Choose paint color. ${selectedSwatch.name} selected`}
        title={`Paint color: ${selectedSwatch.name}`}
        onClick={() => setMobileOpen((open) => !open)}
      >
        <span className="cp-palette-current" style={{ background: selectedSwatch.hex }} aria-hidden />
        <ChevronUp size={18} aria-hidden />
      </button>
    </div>
  );
}

function Swatch({
  i,
  hex,
  name,
  on,
  pick,
}: {
  i: number;
  hex: string;
  name: string;
  on: boolean;
  pick: (i: number) => void;
}) {
  return (
    <button
      type="button"
      className={on ? "cp-swatch cp-on" : "cp-swatch"}
      onClick={() => pick(i)}
      title={name}
      aria-label={name}
      aria-pressed={on}
    >
      <span className="cp-swatch-chip" style={{ background: hex }} aria-hidden />
    </button>
  );
}
