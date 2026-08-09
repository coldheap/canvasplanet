/**
 * Run a map rectangle selection with any open panel stepped aside.
 *
 * A modal backdrop sits over the map, so without this "Draw on map" is a
 * button you can press but never complete. Everything that selects an area —
 * admin regions, revert, image stamp, timelapse — goes through here so the
 * hide/restore can never be forgotten in one of them.
 */

import { useStore } from "../store.js";
import type { MapHandle } from "../components/MapCanvas.js";

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export async function pickBbox(handle: MapHandle | null): Promise<Bbox | null> {
  if (!handle) return null;
  useStore.setState({ mapPicking: true });
  try {
    return await handle.bbox.begin();
  } finally {
    // finally, not after the await: Escape resolves null rather than
    // throwing, but an error here would otherwise leave the panel
    // permanently hidden with no way back.
    useStore.setState({ mapPicking: false });
  }
}
