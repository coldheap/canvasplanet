import L from "leaflet";
import { latLngToPixel } from "@canvasplanet/shared";
import { useStore } from "../store.js";
import type { MapHandle } from "../components/MapCanvas.js";

export interface PixelPoint {
  x: number;
  y: number;
}

/** Single-click pixel picker used when positioning a template. */
export class PointPick {
  private active = false;
  private onDone: ((point: PixelPoint | null) => void) | null = null;

  constructor(private readonly map: L.Map) {}

  begin(): Promise<PixelPoint | null> {
    this.cancel();
    this.active = true;
    this.map.getContainer().style.cursor = "crosshair";
    this.map.on("click", this.onClick);
    document.addEventListener("keydown", this.onKey);

    return new Promise((resolve) => {
      this.onDone = resolve;
    });
  }

  cancel(): void {
    if (!this.active) return;
    this.teardown();
    this.onDone?.(null);
    this.onDone = null;
  }

  destroy(): void {
    this.cancel();
  }

  private teardown(): void {
    this.active = false;
    this.map.getContainer().style.cursor = "";
    this.map.off("click", this.onClick);
    document.removeEventListener("keydown", this.onKey);
  }

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.cancel();
  };

  private onClick = (event: L.LeafletMouseEvent): void => {
    const point = latLngToPixel({ lat: event.latlng.lat, lng: event.latlng.lng });
    this.teardown();
    this.onDone?.(point);
    this.onDone = null;
  };
}

/** Keep map painting disabled for the lifetime of the point-pick gesture. */
export async function pickPoint(handle: MapHandle | null): Promise<PixelPoint | null> {
  if (!handle) return null;
  useStore.setState({ mapPicking: true });
  try {
    return await handle.point.begin();
  } finally {
    useStore.setState({ mapPicking: false });
  }
}
