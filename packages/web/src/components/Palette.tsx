/**
 * Colour picker.
 *
 * Below MIN_PAINT_ZOOM the whole thing collapses to a "Zoom in to paint" hint — a click
 * below the native grid zoom covers multiple pixels and would waste charges
 * on a guess, so the UI refuses rather than letting people misfire.
 */

import { useEffect } from "react";
import { Droplet, MapPin, MapPinOff } from "lucide-react";
import { COST_VIOLATION, Family, MIN_PAINT_ZOOM, PALETTE } from "@canvasplanet/shared";
import { useStore } from "../store.js";

export function PalettePanel({ zoom }: { zoom: number }) {
  const { selectedColor, select } = useStore();

  // 1-9, 0 pick the first 10 swatches (the neutrals/reds — the rest of the
  // 32-colour palette stays click-only). Ignored while typing anywhere else
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

  if (zoom < MIN_PAINT_ZOOM) {
    return (
      <div className="cp-palette cp-palette-locked cp-card">
        <MapPinOff size={16} />
        <span>Zoom in to paint</span>
      </div>
    );
  }

  const land = PALETTE.filter((s) => s.family === Family.Land);
  const water = PALETTE.filter((s) => s.family === Family.Water);

  return (
    <div className="cp-palette cp-card">
      <div className="cp-swatches">
        <span className="cp-swatch-group-label" title="Land colours">
          <MapPin />
        </span>
        <div className="cp-swatch-group">
          {land.map((s) => (
            <Swatch key={s.i} i={s.i} hex={s.hex} name={s.name} on={s.i === selectedColor} pick={select} />
          ))}
        </div>

        {/* Water colours use the terrain-violation rate on land, so they get
            their own group with an icon cue rather than a text label — the
            tooltip carries the current rate. */}
        <span
          className="cp-swatch-group-label"
          title={`Water colours — cost ${COST_VIOLATION} on land`}
        >
          <Droplet />
        </span>
        <div className="cp-swatch-group">
          {water.map((s) => (
            <Swatch key={s.i} i={s.i} hex={s.hex} name={s.name} on={s.i === selectedColor} pick={select} />
          ))}
        </div>
      </div>
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
      className={on ? "cp-swatch cp-on" : "cp-swatch"}
      style={{ background: hex }}
      onClick={() => pick(i)}
      title={name}
      aria-label={name}
      aria-pressed={on}
    />
  );
}
