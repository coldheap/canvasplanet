/**
 * Drag a rectangle on the map and get pixel-space bounds back.
 *
 * Used by the admin panel for protected regions and for revert-by-area, and
 * later by the timelapse picker. Lives outside React because it has to take
 * over Leaflet's own drag handling for the duration, which is imperative.
 *
 * While active it disables map dragging — otherwise the first pointer-down
 * pans the map instead of starting a selection.
 */

import L from "leaflet";
import { latLngToPixel, pixelToLatLng } from "@worldcanvas/shared";

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class BboxDraw {
  private rect: L.Rectangle | null = null;
  private start: { x: number; y: number } | null = null;
  private active = false;
  private onDone: ((bbox: Bbox | null) => void) | null = null;

  /**
   * Consumable one-shot flag: true from the instant a drag ends until the
   * very next "click" is checked. Needed because `begin()` disables
   * `map.dragging`, so Leaflet never records a real drag and fires "click"
   * on the same mouseup that finished the selection anyway — checked (and
   * cleared) by the map's paint-on-click handler in MapCanvas.tsx, not read
   * here. A store flag alone is not enough: resolving the `begin()` promise
   * and clearing it runs as a microtask still inside the mouseup task, which
   * completes before the browser's own "click" task even starts.
   */
  justEnded = false;

  constructor(private readonly map: L.Map) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Begin a selection. Resolves with the bounds, or null if cancelled. */
  begin(): Promise<Bbox | null> {
    this.cancel();
    this.active = true;
    this.map.dragging.disable();
    this.map.getContainer().style.cursor = "crosshair";

    this.map.on("mousedown", this.onDown);
    this.map.on("mousemove", this.onMove);
    this.map.on("mouseup", this.onUp);
    document.addEventListener("keydown", this.onKey);

    return new Promise((resolve) => {
      this.onDone = resolve;
    });
  }

  /** Abort without a result, leaving the map exactly as it was. */
  cancel(): void {
    if (!this.active) return;
    this.teardown();
    this.onDone?.(null);
    this.onDone = null;
  }

  /** Remove the drawn rectangle, e.g. after the region is saved. */
  clear(): void {
    if (this.rect) {
      this.rect.remove();
      this.rect = null;
    }
  }

  destroy(): void {
    this.cancel();
    this.clear();
  }

  private teardown(): void {
    this.active = false;
    this.start = null;
    this.map.dragging.enable();
    this.map.getContainer().style.cursor = "";
    this.map.off("mousedown", this.onDown);
    this.map.off("mousemove", this.onMove);
    this.map.off("mouseup", this.onUp);
    document.removeEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.cancel();
  };

  private onDown = (e: L.LeafletMouseEvent): void => {
    this.clear();
    this.start = latLngToPixel({ lat: e.latlng.lat, lng: e.latlng.lng });
    this.rect = L.rectangle(L.latLngBounds(e.latlng, e.latlng), {
      color: "#2563eb",
      weight: 1,
      fillOpacity: 0.15,
      interactive: false,
    }).addTo(this.map);
  };

  private onMove = (e: L.LeafletMouseEvent): void => {
    if (!this.start || !this.rect) return;
    this.rect.setBounds(this.boundsFrom(latLngToPixel({ lat: e.latlng.lat, lng: e.latlng.lng })));
  };

  private onUp = (e: L.LeafletMouseEvent): void => {
    if (!this.start) return;
    const end = latLngToPixel({ lat: e.latlng.lat, lng: e.latlng.lng });
    const bbox: Bbox = {
      x0: Math.min(this.start.x, end.x),
      y0: Math.min(this.start.y, end.y),
      x1: Math.max(this.start.x, end.x),
      y1: Math.max(this.start.y, end.y),
    };
    this.rect?.setBounds(this.boundsFrom(end));
    this.justEnded = true;
    this.teardown();
    this.onDone?.(bbox);
    this.onDone = null;
  };

  /** Snap the drawn rectangle to whole pixel edges, so what you see is
   *  exactly the range that will be sent. */
  private boundsFrom(end: { x: number; y: number }): L.LatLngBounds {
    const x0 = Math.min(this.start!.x, end.x);
    const y0 = Math.min(this.start!.y, end.y);
    const x1 = Math.max(this.start!.x, end.x) + 1;
    const y1 = Math.max(this.start!.y, end.y) + 1;
    const nw = pixelToLatLng({ x: x0, y: y0 });
    const se = pixelToLatLng({ x: x1, y: y1 });
    return L.latLngBounds([nw.lat, nw.lng], [se.lat, se.lng]);
  }

  /** Draw a persistent outline, e.g. to show an existing protected region. */
  show(bbox: Bbox, color = "#dc2626"): void {
    this.clear();
    const nw = pixelToLatLng({ x: bbox.x0, y: bbox.y0 });
    const se = pixelToLatLng({ x: bbox.x1 + 1, y: bbox.y1 + 1 });
    this.rect = L.rectangle(L.latLngBounds([nw.lat, nw.lng], [se.lat, se.lng]), {
      color,
      weight: 1,
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(this.map);
  }
}
