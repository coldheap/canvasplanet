/**
 * GPU-rendered globe view for the same Web Mercator tile pyramid used by the
 * Leaflet editor. MapLibre's adaptive globe becomes Mercator between zoom 10
 * and 12, so the world reads as a sphere when exploring while individual
 * canvas pixels remain geometrically exact when painting.
 */

import { useEffect, useRef } from "react";
import {
  ERASED,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  MIN_PAINT_ZOOM,
  PALETTE,
  WORLD_SIZE,
  Z_PIXEL,
  latLngToPixel,
  pixelToLatLng,
  type PixelTuple,
} from "@worldcanvas/shared";
import {
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  RasterTileSource,
  type MapMouseEvent,
  type MapTouchEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./GlobeCanvas.css";
import "./PaintCursor.css";
import { normalizeHistoryAt } from "../history.js";
import { useStore } from "../store.js";

const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const LIVE_SETTLE_MS = 2_750;
const LIVE_HANDOFF_MS = 1_500;
const MAX_LIVE_PIXELS = 8_000;
const DOUBLE_TAP_MS = 500;
const DOUBLE_TAP_DISTANCE = 30;
const SPIN_SECONDS_PER_REVOLUTION = 120;
const SPIN_STEP_MS = 1_000;
const SPIN_SLOW_ZOOM = 3;
const SPIN_MAX_ZOOM = 5;
const SPIN_RESUME_MS = 2_500;

interface LivePixel {
  at: number;
  feature: GeoJSON.Feature<GeoJSON.Polygon, { color: string }>;
}

export interface GlobeView {
  lat: number;
  lng: number;
  z: number;
}

export interface GlobeHandle {
  applyPixels: (pixels: readonly PixelTuple[]) => void;
  flyTo: (x: number, y: number, z?: number) => void;
  getView: () => GlobeView;
  refreshTiles: () => void;
}

export function GlobeCanvas({
  initialView,
  onPaint,
  onHover,
  onInspect,
  onOpenMap,
  onReady,
  onViewport,
  onUnavailable,
}: {
  initialView: GlobeView;
  onPaint: (x: number, y: number) => void;
  onHover: (pixel: { x: number; y: number } | null) => void;
  onInspect: (pixel: { x: number; y: number }) => void;
  onOpenMap: (target: { lat: number; lng: number }) => void;
  onReady: (handle: GlobeHandle) => void;
  onViewport: (bbox: { x0: number; y0: number; x1: number; y1: number }, zoom: number) => void;
  onUnavailable: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const cb = useRef({ onPaint, onHover, onInspect, onOpenMap, onReady, onViewport, onUnavailable });
  cb.current = { onPaint, onHover, onInspect, onOpenMap, onReady, onViewport, onUnavailable };

  useEffect(() => {
    document.documentElement.classList.add("wc-globe-active");
    return () => document.documentElement.classList.remove("wc-globe-active");
  }, []);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const state = useStore.getState();
    const historyAt = state.historyAt === null ? null : normalizeHistoryAt(state.historyAt);
    const style = makeStyle(historyAt, state.settings.osmLayer);
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: ref.current,
        style,
        center: [initialView.lng, initialView.lat],
        zoom: initialView.z,
        minZoom: 0,
        maxZoom: MAX_MAP_ZOOM,
        doubleClickZoom: false,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      });
    } catch {
      cb.current.onUnavailable();
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: true, showZoom: true }), "top-right");

    const livePixels = new Map<string, LivePixel>();
    let refreshRevision = 0;
    let refreshTimer: number | null = null;
    let clearTimer: number | null = null;
    let lastHistoryAt = historyAt;
    let lastPainted: string | null = null;
    let shiftDown = false;
    let hoverPixel: { x: number; y: number } | null = null;
    let lastTap: { at: number; x: number; y: number } | null = null;
    let touchStart: { x: number; y: number } | null = null;
    let touchMoved = false;
    let paintPreviewKey: string | null = null;
    let paintCursorVisible = false;
    let lastPointerLngLat: { lng: number; lat: number } | null = null;
    let userInteracting = false;
    let spinInProgress = false;
    let spinResumeTimer: number | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cursorElement = document.createElement("div");
    cursorElement.className = "wc-paint-cursor";
    cursorElement.innerHTML = PAINT_CURSOR_HTML;
    const paintCursor = new Marker({ element: cursorElement, anchor: "top-left" });

    const clearSpinResume = () => {
      if (spinResumeTimer === null) return;
      window.clearTimeout(spinResumeTimer);
      spinResumeTimer = null;
    };

    const spinGlobe = () => {
      clearSpinResume();
      if (userInteracting || reducedMotion.matches || document.hidden || map.getZoom() >= SPIN_MAX_ZOOM) return;

      const zoom = map.getZoom();
      const zoomScale =
        zoom <= SPIN_SLOW_ZOOM ? 1 : (SPIN_MAX_ZOOM - zoom) / (SPIN_MAX_ZOOM - SPIN_SLOW_ZOOM);
      const degrees = (360 / SPIN_SECONDS_PER_REVOLUTION) * (SPIN_STEP_MS / 1_000) * zoomScale;
      const center = map.getCenter();
      spinInProgress = true;
      map.easeTo({
        center: [center.lng - degrees, center.lat],
        duration: SPIN_STEP_MS,
        easing: (t) => t,
        essential: false,
      });
    };

    const pauseSpin = () => {
      userInteracting = true;
      clearSpinResume();
      if (!spinInProgress) return;
      spinInProgress = false;
      map.stop();
    };

    const resumeSpin = (delay = SPIN_RESUME_MS) => {
      userInteracting = false;
      clearSpinResume();
      if (reducedMotion.matches || document.hidden || map.getZoom() >= SPIN_MAX_ZOOM) return;
      spinResumeTimer = window.setTimeout(() => {
        spinResumeTimer = null;
        spinGlobe();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (document.hidden) pauseSpin();
      else resumeSpin();
    };
    const onMotionPreferenceChange = () => {
      if (reducedMotion.matches) pauseSpin();
      else resumeSpin();
    };

    const hidePaintPreview = () => {
      const source = map.getSource("paint-preview") as GeoJSONSource | undefined;
      source?.setData(EMPTY_FEATURES);
      if (paintCursorVisible) {
        paintCursor.remove();
        paintCursorVisible = false;
      }
      paintPreviewKey = null;
      map.getCanvasContainer().classList.remove("wc-paint-preview-active");
    };

    const showPaintPreview = (pixel: { x: number; y: number }) => {
      const current = useStore.getState();
      if (current.historyAt !== null || current.mapPicking || map.getZoom() < MIN_PAINT_ZOOM || !map.isStyleLoaded()) {
        hidePaintPreview();
        return;
      }

      const color = PALETTE[current.selectedColor]?.hex;
      if (!color) return hidePaintPreview();
      const cursorAt = lastPointerLngLat ?? pixelToLatLng({ x: pixel.x + 0.5, y: pixel.y + 0.5 });
      cursorElement.style.setProperty("--wc-paint-color", color);
      paintCursor.setLngLat([cursorAt.lng, cursorAt.lat]);
      if (!paintCursorVisible) {
        paintCursor.addTo(map);
        paintCursorVisible = true;
      }
      map.getCanvasContainer().classList.add("wc-paint-preview-active");

      const previewKey = `${pixel.x},${pixel.y},${color}`;
      if (previewKey === paintPreviewKey) return;
      paintPreviewKey = previewKey;
      const feature = pixelFeature(
        pixel.x + PREVIEW_INSET,
        pixel.y + PREVIEW_INSET,
        color,
        1 - PREVIEW_INSET * 2,
      );
      (map.getSource("paint-preview") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: [feature],
      });
    };

    const renderLivePixels = () => {
      const source = map.getSource("live") as GeoJSONSource | undefined;
      if (!source) return;
      source.setData({
        type: "FeatureCollection",
        features: [...livePixels.values()].map(({ feature }) => feature),
      });
    };

    const refreshTiles = () => {
      const source = map.getSource("canvas") as RasterTileSource | undefined;
      if (!source) return;
      refreshRevision += 1;
      source.setTiles([`/tiles/z${Z_PIXEL}/{z}/{x}/{y}.png?globe=${refreshRevision}`]);
    };

    const scheduleTileHandoff = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        const cutoff = Date.now();
        refreshTiles();
        if (clearTimer !== null) window.clearTimeout(clearTimer);
        clearTimer = window.setTimeout(() => {
          clearTimer = null;
          for (const [key, pixel] of livePixels) {
            if (pixel.at <= cutoff) livePixels.delete(key);
          }
          renderLivePixels();
          if (livePixels.size) scheduleTileHandoff();
        }, LIVE_HANDOFF_MS);
      }, LIVE_SETTLE_MS);
    };

    const applyPixels = (pixels: readonly PixelTuple[]) => {
      const now = Date.now();
      for (const [x, y, color] of pixels) {
        const key = `${x},${y}`;
        if (color === ERASED) {
          livePixels.delete(key);
          continue;
        }
        const swatch = PALETTE[color];
        if (!swatch) continue;
        livePixels.set(key, { at: now, feature: pixelFeature(x, y, swatch.hex) });
      }
      while (livePixels.size > MAX_LIVE_PIXELS) {
        const oldest = livePixels.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        livePixels.delete(oldest);
      }
      renderLivePixels();
      scheduleTileHandoff();
    };

    const getView = (): GlobeView => {
      const center = map.getCenter();
      return { lat: center.lat, lng: center.lng, z: map.getZoom() };
    };

    const flyTo = (x: number, y: number, z = Z_PIXEL) => {
      const target = pixelToLatLng({ x: x + 0.5, y: y + 0.5 });
      map.flyTo({ center: [target.lng, target.lat], zoom: z, duration: 700 });
    };

    const emitViewport = () => {
      const bounds = map.getBounds();
      const nw = latLngToPixel({ lat: bounds.getNorth(), lng: bounds.getWest() });
      const se = latLngToPixel({ lat: bounds.getSouth(), lng: bounds.getEast() });
      const crossesAntimeridian = bounds.getWest() > bounds.getEast();
      cb.current.onViewport(
        {
          x0: crossesAntimeridian ? 0 : Math.min(nw.x, se.x),
          y0: Math.min(nw.y, se.y),
          x1: crossesAntimeridian ? WORLD_SIZE - 1 : Math.max(nw.x, se.x),
          y1: Math.max(nw.y, se.y),
        },
        map.getZoom(),
      );
    };

    const paintAt = (pixel: { x: number; y: number }) => {
      if (useStore.getState().historyAt !== null || map.getZoom() < MIN_PAINT_ZOOM) return;
      const key = `${pixel.x},${pixel.y}`;
      if (key === lastPainted) return;
      lastPainted = key;
      cb.current.onPaint(pixel.x, pixel.y);
    };

    const onClick = (event: MapMouseEvent) => {
      const current = useStore.getState();
      if (current.panel === "activity") {
        current.setPanel("none");
        return;
      }
      if (shiftDown || current.historyAt !== null || current.mapPicking || map.getZoom() < MIN_PAINT_ZOOM) return;
      const pixel = latLngToPixel(event.lngLat);
      cb.current.onPaint(pixel.x, pixel.y);
    };
    const onMouseMove = (event: MapMouseEvent) => {
      if (useStore.getState().historyAt !== null || map.getZoom() < MIN_PAINT_ZOOM) {
        hoverPixel = null;
        hidePaintPreview();
        cb.current.onHover(null);
        return;
      }
      hoverPixel = latLngToPixel(event.lngLat);
      lastPointerLngLat = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      showPaintPreview(hoverPixel);
      cb.current.onHover(hoverPixel);
      if (shiftDown) paintAt(hoverPixel);
    };
    const onMouseOut = () => {
      hoverPixel = null;
      lastPointerLngLat = null;
      hidePaintPreview();
      cb.current.onHover(null);
    };
    const onContextMenu = (event: MapMouseEvent) => {
      if (useStore.getState().historyAt !== null) return;
      event.preventDefault();
      cb.current.onInspect(latLngToPixel(event.lngLat));
    };
    const onDoubleClick = (event: MapMouseEvent) => {
      event.preventDefault();
      cb.current.onOpenMap({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    };
    // MapLibre exposes mouse double-clicks as map events, but handles touch
    // double-taps internally. Recognise two stationary taps here so both
    // input methods lead to the same 2D destination.
    const onTouchStart = (event: MapTouchEvent) => {
      pauseSpin();
      touchMoved = false;
      const point = event.points.length === 1 ? event.points[0]! : null;
      touchStart = point ? { x: point.x, y: point.y } : null;
    };
    const onTouchMove = (event: MapTouchEvent) => {
      const point = event.points.length === 1 ? event.points[0]! : null;
      if (!point || !touchStart || Math.hypot(point.x - touchStart.x, point.y - touchStart.y) > DOUBLE_TAP_DISTANCE) {
        touchMoved = true;
        lastTap = null;
      }
    };
    const onTouchEnd = (event: MapTouchEvent) => {
      const original = event.originalEvent;
      touchStart = null;
      if (original.touches.length === 0) resumeSpin();
      if (touchMoved || original.touches.length !== 0 || event.points.length !== 1) {
        lastTap = null;
        return;
      }

      const point = event.points[0]!;
      const secondTap =
        lastTap !== null &&
        original.timeStamp - lastTap.at <= DOUBLE_TAP_MS &&
        Math.hypot(point.x - lastTap.x, point.y - lastTap.y) <= DOUBLE_TAP_DISTANCE;
      if (!secondTap) {
        lastTap = { at: original.timeStamp, x: point.x, y: point.y };
        return;
      }

      lastTap = null;
      original.preventDefault();
      cb.current.onOpenMap({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    };
    const onTouchCancel = (event: MapTouchEvent) => {
      touchStart = null;
      touchMoved = false;
      lastTap = null;
      if (event.originalEvent.touches.length === 0) resumeSpin();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing || event.key !== "Shift" || shiftDown || useStore.getState().historyAt !== null) return;
      shiftDown = true;
      map.dragPan.disable();
      if (hoverPixel) paintAt(hoverPixel);
    };
    const stopShiftPaint = () => {
      if (!shiftDown) return;
      shiftDown = false;
      lastPainted = null;
      map.dragPan.enable();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") stopShiftPaint();
    };
    const onMouseDown = () => pauseSpin();
    const onMouseUp = () => resumeSpin();
    const onWheel = () => {
      pauseSpin();
      resumeSpin();
    };
    const onMoveEnd = () => {
      const completedSpin = spinInProgress;
      spinInProgress = false;
      writeHash(map);
      emitViewport();
      if (completedSpin) spinGlobe();
      else if (!userInteracting) resumeSpin();
    };

    map.on("click", onClick);
    map.on("mousedown", onMouseDown);
    map.on("mouseup", onMouseUp);
    map.on("wheel", onWheel);
    map.on("dragend", onMouseUp);
    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    map.on("contextmenu", onContextMenu);
    map.on("dblclick", onDoubleClick);
    map.on("touchstart", onTouchStart);
    map.on("touchmove", onTouchMove);
    map.on("touchend", onTouchEnd);
    map.on("touchcancel", onTouchCancel);
    map.on("moveend", onMoveEnd);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stopShiftPaint);
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener("change", onMotionPreferenceChange);

    map.once("load", () => {
      emitViewport();
      cb.current.onReady({ applyPixels, flyTo, getView, refreshTiles });
      resumeSpin(600);
    });

    const unsubscribe = useStore.subscribe((next) => {
      if (!map.isStyleLoaded()) return;
      map.setLayoutProperty("osm", "visibility", next.settings.osmLayer ? "visible" : "none");
      const selected = next.historyAt === null ? null : normalizeHistoryAt(next.historyAt);
      if (selected !== lastHistoryAt) {
        lastHistoryAt = selected;
        if (selected !== null) {
          const source = map.getSource("history") as RasterTileSource;
          source.setTiles([`/api/history/tiles/${selected}/{z}/{x}/{y}.png`]);
        }
      }
      map.setLayoutProperty("canvas", "visibility", selected === null ? "visible" : "none");
      map.setLayoutProperty("live-pixels", "visibility", selected === null ? "visible" : "none");
      map.setLayoutProperty("history", "visibility", selected === null ? "none" : "visible");
      map.setLayoutProperty("paint-preview-fill", "visibility", selected === null ? "visible" : "none");
      if (hoverPixel) showPaintPreview(hoverPixel);
      else hidePaintPreview();
    });

    return () => {
      unsubscribe();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      clearSpinResume();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stopShiftPaint);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotion.removeEventListener("change", onMotionPreferenceChange);
      hidePaintPreview();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div
      className="wc-globe-view"
      aria-label="Interactive 3D globe canvas. Double-tap a location to open the flat map."
    >
      <div ref={ref} />
      <a
        className="wc-globe-credit"
        href="https://www.eso.org/public/images/eso0932a/"
        target="_blank"
        rel="noreferrer"
      >
        ESO/S. Brunier
      </a>
    </div>
  );
}

export default GlobeCanvas;

function makeStyle(historyAt: number | null, osmLayer: boolean): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    sources: {
      basemap: { type: "raster", tiles: ["/basemap/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 8 },
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© OpenStreetMap contributors",
      },
      canvas: { type: "raster", tiles: [`/tiles/z${Z_PIXEL}/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: Z_PIXEL },
      history: {
        type: "raster",
        tiles: [
          historyAt === null
            ? `/tiles/z${Z_PIXEL}/{z}/{x}/{y}.png`
            : `/api/history/tiles/${historyAt}/{z}/{x}/{y}.png`,
        ],
        tileSize: 256,
        minzoom: Z_PIXEL,
        maxzoom: Z_PIXEL,
      },
      live: { type: "geojson", data: EMPTY_FEATURES },
      "paint-preview": { type: "geojson", data: EMPTY_FEATURES },
    },
    layers: [
      { id: "basemap", type: "raster", source: "basemap", paint: { "raster-fade-duration": 0 } },
      {
        id: "osm",
        type: "raster",
        source: "osm",
        layout: { visibility: osmLayer ? "visible" : "none" },
        paint: { "raster-opacity": 0.78, "raster-fade-duration": 0 },
      },
      {
        id: "canvas",
        type: "raster",
        source: "canvas",
        layout: { visibility: historyAt === null ? "visible" : "none" },
        paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" },
      },
      {
        id: "history",
        type: "raster",
        source: "history",
        layout: { visibility: historyAt === null ? "none" : "visible" },
        paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" },
      },
      {
        id: "live-pixels",
        type: "fill",
        source: "live",
        layout: { visibility: historyAt === null ? "visible" : "none" },
        paint: { "fill-color": ["get", "color"], "fill-antialias": false },
      },
      {
        id: "paint-preview-fill",
        type: "fill",
        source: "paint-preview",
        layout: { visibility: historyAt === null ? "visible" : "none" },
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.78, "fill-antialias": false },
      },
    ],
    sky: {
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 7, 0.6, 10, 0],
    },
  };
}

function pixelFeature(x: number, y: number, color: string, size = 1): LivePixel["feature"] {
  const nw = pixelToLatLng({ x, y });
  const se = pixelToLatLng({ x: x + size, y: y + size });
  return {
    type: "Feature",
    properties: { color },
    geometry: {
      type: "Polygon",
      coordinates: [[[nw.lng, nw.lat], [se.lng, nw.lat], [se.lng, se.lat], [nw.lng, se.lat], [nw.lng, nw.lat]]],
    },
  };
}

const PREVIEW_INSET = 0.28;
const PAINT_CURSOR_HTML = `<svg viewBox="0 0 24 28" aria-hidden="true">
  <path class="wc-paint-cursor-pointer" d="M1 1.5 2.2 21l5-4.8 4.1 10 4.3-1.9-4.1-9.7 7-.2L1 1.5Z" />
  <circle class="wc-paint-cursor-chip-border" cx="17" cy="7" r="5" />
  <circle class="wc-paint-cursor-swatch" cx="17" cy="7" r="3.6" />
</svg>`;

function writeHash(map: MapLibreMap): void {
  // Flat-map links intentionally start at zoom 2. When the complete globe is
  // visible below that, retain the last shareable hash instead of writing one
  // the Leaflet view cannot open.
  const zoom = Math.round(map.getZoom());
  if (zoom < MIN_MAP_ZOOM) return;
  const center = map.getCenter();
  const { x, y } = latLngToPixel(center);
  history.replaceState(null, "", `#${zoom}/${x}/${y}`);
}
