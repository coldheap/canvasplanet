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
  NavigationControl,
  RasterTileSource,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./GlobeCanvas.css";
import { normalizeHistoryAt } from "../history.js";
import { PLACEMENT_FLASH_MIN_ZOOM, placementFlashPresentation } from "../canvas/placementFlash.js";
import { useStore } from "../store.js";

const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const LIVE_SETTLE_MS = 2_750;
const LIVE_HANDOFF_MS = 1_500;
const MAX_LIVE_PIXELS = 8_000;

interface LivePixel {
  at: number;
  feature: GeoJSON.Feature<GeoJSON.Polygon, { color: string }>;
}

interface PlacementFlash {
  at: number;
  duration: number;
  reduced: boolean;
  feature: GeoJSON.Feature<GeoJSON.Polygon, { opacity: number }>;
}

export interface GlobeView {
  lat: number;
  lng: number;
  z: number;
}

export interface GlobeHandle {
  applyPixels: (pixels: readonly PixelTuple[]) => void;
  flyTo: (x: number, y: number, z?: number) => void;
  flashPixel: (x: number, y: number) => void;
  getView: () => GlobeView;
  refreshTiles: () => void;
}

export function GlobeCanvas({
  initialView,
  onPaint,
  onHover,
  onInspect,
  onReady,
  onViewport,
  onUnavailable,
}: {
  initialView: GlobeView;
  onPaint: (x: number, y: number) => void;
  onHover: (pixel: { x: number; y: number } | null) => void;
  onInspect: (pixel: { x: number; y: number }) => void;
  onReady: (handle: GlobeHandle) => void;
  onViewport: (bbox: { x0: number; y0: number; x1: number; y1: number }, zoom: number) => void;
  onUnavailable: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const cb = useRef({ onPaint, onHover, onInspect, onReady, onViewport, onUnavailable });
  cb.current = { onPaint, onHover, onInspect, onReady, onViewport, onUnavailable };

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
    const placementFlashes = new Map<number, PlacementFlash>();
    let placementFlashId = 0;
    let placementFrame: number | null = null;

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

    const flashPixel = (x: number, y: number) => {
      if (map.getZoom() < PLACEMENT_FLASH_MIN_ZOOM) return;
      const { duration, reduced } = placementFlashPresentation();
      placementFlashes.set(++placementFlashId, {
        at: performance.now(),
        duration,
        reduced,
        feature: placementFeature(x, y),
      });
      if (placementFrame === null) placementFrame = requestAnimationFrame(renderPlacementFlashes);
    };

    const renderPlacementFlashes = (now: number) => {
      const source = map.getSource("placement-flashes") as GeoJSONSource | undefined;
      if (!source) return;
      for (const [id, flash] of placementFlashes) {
        const progress = (now - flash.at) / flash.duration;
        if (progress >= 1) {
          placementFlashes.delete(id);
          continue;
        }
        flash.feature.properties.opacity = flash.reduced ? 0.9 : Math.max(0, 1 - progress);
      }
      source.setData({
        type: "FeatureCollection",
        features: [...placementFlashes.values()].map(({ feature }) => feature),
      });
      placementFrame = placementFlashes.size ? requestAnimationFrame(renderPlacementFlashes) : null;
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
        cb.current.onHover(null);
        return;
      }
      hoverPixel = latLngToPixel(event.lngLat);
      cb.current.onHover(hoverPixel);
      if (shiftDown) paintAt(hoverPixel);
    };
    const onMouseOut = () => {
      hoverPixel = null;
      cb.current.onHover(null);
    };
    const onContextMenu = (event: MapMouseEvent) => {
      if (useStore.getState().historyAt !== null) return;
      event.preventDefault();
      cb.current.onInspect(latLngToPixel(event.lngLat));
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

    map.on("click", onClick);
    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    map.on("contextmenu", onContextMenu);
    map.on("moveend", () => {
      writeHash(map);
      emitViewport();
    });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stopShiftPaint);

    map.once("load", () => {
      emitViewport();
      cb.current.onReady({ applyPixels, flyTo, flashPixel, getView, refreshTiles });
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
      map.setLayoutProperty("placement-flashes", "visibility", selected === null ? "visible" : "none");
      map.setLayoutProperty("history", "visibility", selected === null ? "none" : "visible");
    });

    return () => {
      unsubscribe();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      if (placementFrame !== null) cancelAnimationFrame(placementFrame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stopShiftPaint);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return <div ref={ref} className="wc-globe-view" aria-label="Interactive 3D globe canvas" />;
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
      "placement-flashes": { type: "geojson", data: EMPTY_FEATURES },
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
        id: "placement-flashes",
        type: "fill",
        source: "placement-flashes",
        minzoom: PLACEMENT_FLASH_MIN_ZOOM,
        layout: { visibility: historyAt === null ? "visible" : "none" },
        paint: { "fill-color": "#ef4444", "fill-opacity": ["get", "opacity"], "fill-antialias": false },
      },
    ],
    sky: {
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 7, 0.6, 10, 0],
    },
  };
}

function pixelFeature(x: number, y: number, color: string): LivePixel["feature"] {
  const nw = pixelToLatLng({ x, y });
  const se = pixelToLatLng({ x: x + 1, y: y + 1 });
  return {
    type: "Feature",
    properties: { color },
    geometry: {
      type: "Polygon",
      coordinates: [[[nw.lng, nw.lat], [se.lng, nw.lat], [se.lng, se.lat], [nw.lng, se.lat], [nw.lng, nw.lat]]],
    },
  };
}

function placementFeature(x: number, y: number): PlacementFlash["feature"] {
  const nw = pixelToLatLng({ x, y });
  const se = pixelToLatLng({ x: x + 1, y: y + 1 });
  return {
    type: "Feature",
    properties: { opacity: 1 },
    geometry: {
      type: "Polygon",
      coordinates: [[[nw.lng, nw.lat], [se.lng, nw.lat], [se.lng, se.lat], [nw.lng, se.lat], [nw.lng, nw.lat]]],
    },
  };
}

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
