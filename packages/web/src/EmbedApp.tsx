/**
 * The embeddable widget (ROADMAP.md §4.2) — a read-only `<iframe src="/embed.html?...">`
 * view of a region, for communities to put their artwork on their own site.
 *
 * Deliberately a separate entry point from the main app (see embed.html /
 * embed-main.tsx), not a route inside it: this bundle ships to every page
 * that embeds it, so it carries none of the palette, admin, template or
 * timelapse code the main app needs.
 *
 * No session, no cookie, no bootstrap call — see ws.ts's `readOnly` mode and
 * index.ts's `?ro=1` for why: a cookie set from inside a cross-origin iframe
 * cannot be relied on to come back on subsequent requests (SameSite=Lax),
 * so this never tries. Live pixels arrive over the same WS hub everyone
 * else uses, just anonymously.
 *
 * `?osm=1` opts into the OSM street map basemap under the pixels; off by
 * default, same as the main app (see MapCanvas.tsx's Settings → Canvas →
 * Street map overlay toggle).
 */

import { useEffect, useRef } from "react";
import L from "leaflet";
import {
  BASEMAP_MAX_ZOOM,
  DEFAULT_VIEW,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  SITE_NAME,
  WORLD_SIZE,
  Z_PIXEL,
  latLngToPixel,
  pixelToLatLng,
} from "@worldcanvas/shared";
import { LiveOverlay } from "./canvas/liveOverlay.js";
import { WsClient } from "./ws.js";

interface EmbedBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function parseBbox(): EmbedBbox | null {
  const p = new URLSearchParams(location.search);
  const raw = ["x0", "y0", "x1", "y1"].map((k) => Number(p.get(k)));
  if (raw.some((n) => !Number.isFinite(n))) return null;
  const clamp = (n: number) => Math.max(0, Math.min(WORLD_SIZE - 1, Math.round(n)));
  const x0 = clamp(Math.min(raw[0]!, raw[2]!));
  const x1 = clamp(Math.max(raw[0]!, raw[2]!));
  const y0 = clamp(Math.min(raw[1]!, raw[3]!));
  const y1 = clamp(Math.max(raw[1]!, raw[3]!));
  return { x0, y0, x1, y1 };
}

// Read once at module scope: an embed iframe never navigates, so the query
// string driving it is fixed for its whole lifetime.
const bbox = parseBbox();
const center = bbox
  ? { x: Math.round((bbox.x0 + bbox.x1) / 2), y: Math.round((bbox.y0 + bbox.y1) / 2) }
  : { x: DEFAULT_VIEW.x, y: DEFAULT_VIEW.y };
// Off by default, same as the main app — the embed shows the pixels
// themselves. `?osm=1` opts into the OSM street map underneath them.
const showOsm = new URLSearchParams(location.search).get("osm") === "1";

export function EmbedApp() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const map = L.map(ref.current, {
      center: pixelToLatLng(center) as never,
      zoom: DEFAULT_VIEW.z,
      minZoom: MIN_MAP_ZOOM,
      maxZoom: MAX_MAP_ZOOM,
      zoomSnap: 1,
      worldCopyJump: true,
      attributionControl: false,
    });

    if (bbox) {
      const nw = pixelToLatLng({ x: bbox.x0, y: bbox.y0 });
      const se = pixelToLatLng({ x: bbox.x1 + 1, y: bbox.y1 + 1 });
      map.fitBounds([
        [nw.lat, nw.lng],
        [se.lat, se.lng],
      ] as never, { padding: [16, 16] });
    }

    // Always on, same land/ocean backdrop as the main app — see
    // MapCanvas.tsx's layer-stack doc comment.
    L.tileLayer("/basemap/{z}/{x}/{y}.png", {
      maxNativeZoom: BASEMAP_MAX_ZOOM,
      maxZoom: MAX_MAP_ZOOM,
      zIndex: 0,
    }).addTo(map);

    if (showOsm) {
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: MAX_MAP_ZOOM,
        zIndex: 1,
      }).addTo(map);
    }

    // maxNativeZoom pins requests to Z_PIXEL and lets Leaflet upscale beyond it —
    // same reasoning as the main map (see MapCanvas.tsx).
    const canvasLayer = L.tileLayer("/tiles/{z}/{x}/{y}.png", {
      maxNativeZoom: Z_PIXEL,
      maxZoom: MAX_MAP_ZOOM,
      className: "wc-canvas-layer",
      keepBuffer: 4,
      zIndex: 2,
    }).addTo(map);

    const overlay = new LiveOverlay(map);
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

    const ws = new WsClient(
      {
        onPixels: (pixels) => overlay.add(pixels),
        // A gap while disconnected is in the tile PNGs, not the stream —
        // same handoff the main app uses on reconnect.
        onReconnect: () => canvasLayer.redraw(),
      },
      /* readOnly */ true,
    );
    ws.connect();

    const emitViewport = () => {
      const b = map.getBounds();
      const nwP = latLngToPixel({ lat: b.getNorth(), lng: b.getWest() });
      const seP = latLngToPixel({ lat: b.getSouth(), lng: b.getEast() });
      ws.setViewport(
        {
          x0: Math.min(nwP.x, seP.x),
          y0: Math.min(nwP.y, seP.y),
          x1: Math.max(nwP.x, seP.x),
          y1: Math.max(nwP.y, seP.y),
        },
        map.getZoom(),
      );
    };
    map.on("moveend zoomend", emitViewport);
    emitViewport();

    return () => {
      map.off("moveend zoomend", emitViewport);
      // Before the map/overlay: an already-in-flight or still-open socket
      // would otherwise keep calling onPixels/onReconnect against objects
      // this cleanup is about to tear down (see ws.ts's disconnect() doc).
      ws.disconnect();
      overlay.destroy();
      map.remove();
    };
  }, []);

  return (
    <>
      <div ref={ref} className="wc-embed-map" />
      <a
        className="wc-embed-badge"
        href={`${location.origin}/#${Z_PIXEL}/${center.x}/${center.y}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        live on {SITE_NAME}
      </a>
    </>
  );
}
