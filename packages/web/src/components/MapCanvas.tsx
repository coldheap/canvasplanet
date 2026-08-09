/**
 * The map, the canvas, and the click-to-paint interaction.
 *
 * Four stacked layers, bottom to top:
 *   1. OSM raster basemap
 *   2. /tiles TileLayer — the authoritative canvas, up to ~2s stale
 *   3. the live-delta overlay canvas (see canvas/liveOverlay.ts)
 *   4. the grid + cursor highlight
 *
 * Layer 3 is what makes paint feel instant despite the debounced tile
 * worker. Layer 2 and layer 3 hand off to each other on `tileload`.
 */

import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import L from "leaflet";
import {
  GRID_ZOOM,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  MIN_PAINT_ZOOM,
  Z_PIXEL,
  pixelToLatLng,
  latLngToPixel,
} from "@worldcanvas/shared";
import { BboxDraw } from "../canvas/bboxDraw.js";
import { createHeatLayer } from "../canvas/heatLayer.js";
import { LiveOverlay } from "../canvas/liveOverlay.js";
import { TemplateLayer } from "../canvas/templateLayer.js";
import { useStore } from "../store.js";

export interface MapHandle {
  map: L.Map;
  overlay: LiveOverlay;
  /** Force every canvas tile to refetch — used after a WS reconnect. */
  refreshTiles: () => void;
  /** Animate to a pixel coordinate. Used by country pages to fly to a hotspot. */
  flyTo: (x: number, y: number, z?: number) => void;
  /** Rectangle selection, for admin regions and revert-by-area. */
  bbox: BboxDraw;
  /** The template ghost, aligned to the pixel grid. */
  template: TemplateLayer;
}

export function MapCanvas({
  onPaint,
  onHover,
  onInspect,
  onReady,
  onViewport,
}: {
  onPaint: (x: number, y: number) => void;
  onHover: (pixel: { x: number; y: number } | null) => void;
  /** Right-click / long-press: pin the inspector on a pixel. */
  onInspect: (pixel: { x: number; y: number }) => void;
  onReady: (handle: MapHandle) => void;
  onViewport: (bbox: { x0: number; y0: number; x1: number; y1: number }, zoom: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  // Effect callbacks are captured once on mount; route them through a ref so
  // the map is never torn down and rebuilt just because a handler changed.
  const cb = useRef({ onPaint, onHover, onInspect, onReady, onViewport });
  cb.current = { onPaint, onHover, onInspect, onReady, onViewport };

  useEffect(() => {
    if (!ref.current || mapRef.current) return;

    const start = readHash() ?? { z: Z_PIXEL, x: 524288, y: 524288 };
    const map = L.map(ref.current, {
      center: pixelToLatLng({ x: start.x, y: start.y }) as never,
      zoom: start.z,
      minZoom: MIN_MAP_ZOOM,
      maxZoom: MAX_MAP_ZOOM,
      zoomControl: false,
      attributionControl: false,
      // Integer zoom only: the grid is defined at z12 and fractional zoom
      // would land pixels on half-pixel boundaries.
      zoomSnap: 1,
      worldCopyJump: true,
      // The whole app is a click target; double-click-to-zoom would make
      // every fast double paint zoom the map instead.
      doubleClickZoom: false,
      // Leaflet's default shift-drag gesture is "draw a box, zoom to it" —
      // if the mouse button happens to be down during a shift-paint stroke
      // below, its mouseup handler calls fitBounds(), yanking the view away
      // mid-stroke so painted pixels appear to vanish.
      boxZoom: false,
    });
    mapRef.current = map;

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: MAX_MAP_ZOOM,
    }).addTo(map);

    // The canvas. maxNativeZoom pins requests to z12 and lets Leaflet upscale
    // beyond it, so zooming in shows crisp big pixels instead of asking the
    // server for tiles that do not exist.
    const canvasLayer = L.tileLayer("/tiles/{z}/{x}/{y}.png", {
      maxNativeZoom: Z_PIXEL,
      maxZoom: MAX_MAP_ZOOM,
      className: "wc-canvas-layer",
      keepBuffer: 4,
    }).addTo(map);

    const overlay = new LiveOverlay(map);

    // ---- tile <-> overlay handoff -----------------------------------------
    // Record when each tile began loading, then on load drop the overlay
    // pixels inside it that predate that moment. Using the START time is the
    // point: a pixel painted while the PNG was in flight is NOT in that PNG,
    // so it has to stay in the overlay.
    const loadStarted = new Map<string, number>();
    canvasLayer.on("tileloadstart", (e: L.TileEvent) => {
      const c = e.coords;
      loadStarted.set(`${c.z}/${c.x}/${c.y}`, Date.now());
    });
    canvasLayer.on("tileload", (e: L.TileEvent) => {
      const c = e.coords;
      const k = `${c.z}/${c.x}/${c.y}`;
      overlay.clearTile(c.z, c.x, c.y, loadStarted.get(k) ?? 0);
      loadStarted.delete(k);
    });

    const refreshTiles = () => canvasLayer.redraw();

    const flyTo = (x: number, y: number, z = Z_PIXEL) => {
      // Aim at the pixel's centre, not its corner, or the target sits half a
      // pixel off at high zoom.
      const target = pixelToLatLng({ x: x + 0.5, y: y + 0.5 });
      map.flyTo([target.lat, target.lng] as never, z, { duration: 1.2 });
    };

    // ---- grid overlay ------------------------------------------------------
    const grid = new GridLayer();
    const applyGrid = () => {
      const mode = useStore.getState().settings.grid;
      const on = mode === "on" || (mode === "auto" && map.getZoom() >= GRID_ZOOM);
      if (on && !map.hasLayer(grid)) grid.addTo(map);
      else if (!on && map.hasLayer(grid)) map.removeLayer(grid);
    };

    // ---- heatmap overlay -----------------------------------------------------
    // Above the canvas layer but below the grid/overlay, so gridlines and the
    // live-paint overlay still read on top of it.
    const heat = createHeatLayer();
    const applyHeat = () => {
      const on = useStore.getState().settings.heatmap;
      if (on && !map.hasLayer(heat)) heat.addTo(map);
      else if (!on && map.hasLayer(heat)) map.removeLayer(heat);
    };

    // ---- interaction -------------------------------------------------------
    // Shift held: moving the mouse paints a freehand stroke, one call to
    // onPaint per pixel entered — no click or held button required. Map
    // dragging (pan) is disabled for the duration so an accidental drag
    // cannot also pan mid-stroke.
    const shiftDown = { current: false };
    const lastPainted = { current: null as string | null };
    const lastHoverPixel = { current: null as { x: number; y: number } | null };

    const paintAt = (pixel: { x: number; y: number }) => {
      if (map.getZoom() < MIN_PAINT_ZOOM) return;
      const key = `${pixel.x},${pixel.y}`;
      if (key === lastPainted.current) return;
      lastPainted.current = key;
      cb.current.onPaint(pixel.x, pixel.y);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || shiftDown.current) return;
      shiftDown.current = true;
      map.dragging.disable();
      // Paint under the cursor immediately, since a stationary mouse never
      // fires mousemove to trigger the paint below.
      if (lastHoverPixel.current) paintAt(lastHoverPixel.current);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      shiftDown.current = false;
      lastPainted.current = null;
      map.dragging.enable();
    };
    // Losing focus (alt-tab, devtools) mid-hold would otherwise leave
    // dragging disabled forever, since no keyup ever arrives.
    const onBlur = () => {
      if (!shiftDown.current) return;
      shiftDown.current = false;
      lastPainted.current = null;
      map.dragging.enable();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    map.on("click", (e: L.LeafletMouseEvent) => {
      // While shift is held, painting happens on mousemove below — a click
      // here would double-paint the pixel the hover-stroke just did.
      if (shiftDown.current) return;
      if (map.getZoom() < MIN_PAINT_ZOOM) return; // view-only below z12
      // A bbox drag (timelapse/revert/regions/stamp/report/embed all go
      // through pickBbox) disables map.dragging for its duration, so Leaflet
      // never records a real drag and fires "click" on the release anyway —
      // without either guard, finishing any area selection also paints (and
      // spends a charge on) whatever pixel the drag ended on. `mapPicking`
      // covers "still picking"; `bbox.justEnded` covers the specific click
      // Leaflet synthesizes from the mouseup that just finished one — that
      // flag flips back to false as a microtask inside the mouseup task
      // itself, before this "click" task even runs, so it cannot be read
      // here reliably and has to be consumed via BboxDraw instead.
      if (useStore.getState().mapPicking) return;
      if (bbox.justEnded) {
        bbox.justEnded = false;
        return;
      }
      const { x, y } = latLngToPixel({ lat: e.latlng.lat, lng: e.latlng.lng });
      cb.current.onPaint(x, y);
    });

    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (map.getZoom() < MIN_PAINT_ZOOM) {
        lastHoverPixel.current = null;
        return cb.current.onHover(null);
      }
      const pixel = latLngToPixel({ lat: e.latlng.lat, lng: e.latlng.lng });
      lastHoverPixel.current = pixel;
      cb.current.onHover(pixel);
      if (shiftDown.current) paintAt(pixel);
    });
    map.on("mouseout", () => {
      lastHoverPixel.current = null;
      cb.current.onHover(null);
    });

    // Right-click pins the inspector. Leaflet's "contextmenu" also fires on
    // a long press on touch, so this works on a phone without a second
    // gesture to teach.
    map.on("contextmenu", (e: L.LeafletMouseEvent) => {
      cb.current.onInspect(latLngToPixel({ lat: e.latlng.lat, lng: e.latlng.lng }));
    });

    const emitViewport = () => {
      const b = map.getBounds();
      const nw = latLngToPixel({ lat: b.getNorth(), lng: b.getWest() });
      const se = latLngToPixel({ lat: b.getSouth(), lng: b.getEast() });
      cb.current.onViewport(
        { x0: Math.min(nw.x, se.x), y0: Math.min(nw.y, se.y), x1: Math.max(nw.x, se.x), y1: Math.max(nw.y, se.y) },
        map.getZoom(),
      );
    };

    map.on("moveend zoomend", () => {
      writeHash(map);
      applyGrid();
      emitViewport();
    });

    applyGrid();
    applyHeat();
    emitViewport();
    const bbox = new BboxDraw(map);
    const template = new TemplateLayer(map);
    cb.current.onReady({ map, overlay, refreshTiles, flyTo, bbox, template });

    // Settings can toggle the grid or heatmap without a map event to hang off.
    const unsubscribe = useStore.subscribe(() => {
      applyGrid();
      applyHeat();
    });

    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Before map.remove(): a live selection has document-level listeners
      // and has disabled map dragging, neither of which map.remove() undoes.
      bbox.destroy();
      template.destroy();
      overlay.destroy();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const frozen = useStore((s) => s.frozen);

  return (
    <>
      <div ref={ref} className="wc-map" />
      {frozen && (
        <div className="wc-frozen-banner">
          <AlertTriangle size={15} />
          The canvas is temporarily frozen.
        </div>
      )}
    </>
  );
}

/**
 * Pixel gridlines, drawn per Leaflet tile so they pan and zoom for free.
 * Only meaningful at z14+, where a pixel is at least 4 screen pixels.
 */
const GridLayer = L.GridLayer.extend({
  createTile(coords: L.Coords) {
    const tile = L.DomUtil.create("canvas") as HTMLCanvasElement;
    const size = 256;
    tile.width = size;
    tile.height = size;
    const ctx = tile.getContext("2d")!;

    // Pixels per tile shrinks as you zoom past z12; below 4px spacing the
    // lines would be denser than the pixels they describe.
    const pxSize = 2 ** (coords.z - Z_PIXEL);
    if (pxSize < 4) return tile;

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let p = 0; p <= size; p += pxSize) {
      // +0.5 puts the stroke on the pixel centre so it renders 1px crisp
      // rather than 2px blurred.
      ctx.moveTo(p + 0.5, 0);
      ctx.lineTo(p + 0.5, size);
      ctx.moveTo(0, p + 0.5);
      ctx.lineTo(size, p + 0.5);
    }
    ctx.stroke();
    return tile;
  },
}) as unknown as new () => L.GridLayer;

/** The URL hash is the single source of truth for map position, so "share
 *  this view" is a string copy and deep links work in both directions. */
function readHash(): { z: number; x: number; y: number } | null {
  const m = /^#(\d+)\/(\d+)\/(\d+)$/.exec(location.hash);
  if (!m) return null;
  return { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

function writeHash(map: L.Map): void {
  const c = map.getCenter();
  const { x, y } = latLngToPixel({ lat: c.lat, lng: c.lng });
  history.replaceState(null, "", `#${map.getZoom()}/${x}/${y}`);
}
