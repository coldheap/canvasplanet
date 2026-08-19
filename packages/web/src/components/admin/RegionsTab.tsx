/**
 * Protected regions: draw a rectangle on the live map, name it, protect it.
 *
 * The landmark is protected by a hardcoded fallback in the server's policy
 * module as well as by its row, so deleting it here cannot expose it. Every
 * other region is exactly what this list says.
 */

import { useEffect, useState } from "react";
import { MapPinned, Square, Trash2 } from "lucide-react";
import { api, type AdminRegion } from "../../api.js";
import { pickBbox } from "../../canvas/pickBbox.js";
import type { MapHandle } from "../MapCanvas.js";

export function RegionsTab({ handle }: { handle: MapHandle | null }) {
  const [regions, setRegions] = useState<AdminRegion[] | null>(null);
  const [drawn, setDrawn] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [name, setName] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.admin.regions().then(setRegions).catch(() => setError("Could not load regions."));
  useEffect(() => {
    void load();
  }, []);

  // Leaving the tab mid-draw (or with an un-discarded rectangle) must not
  // strand the blue drawing rectangle on the live map with no panel left to
  // clear it from.
  useEffect(() => {
    return () => {
      handle?.bbox.cancel();
      handle?.bbox.clear();
    };
  }, [handle]);

  async function draw(): Promise<void> {
    if (!handle) return;
    setDrawing(true);
    setError(null);
    try {
      const bbox = await pickBbox(handle);
      if (bbox) setDrawn(bbox);
    } finally {
      setDrawing(false);
    }
  }

  async function protect(): Promise<void> {
    if (!drawn || !name.trim()) return;
    try {
      await api.admin.addRegion({ name: name.trim(), ...drawn });
      handle?.bbox.clear();
      setDrawn(null);
      setName("");
      await load();
    } catch {
      setError("Could not create that region.");
    }
  }

  const area = drawn ? (drawn.x1 - drawn.x0 + 1) * (drawn.y1 - drawn.y0 + 1) : 0;

  return (
    <section>
      <p className="cp-hint">
        Painting is refused inside a protected region — for everyone, including
        an admin image stamp.
      </p>

      <div className="cp-actions">
        <button className="cp-btn" disabled={!handle || drawing} onClick={() => void draw()}>
          <Square size={15} />
          {drawing ? "Drag on the map… (Esc to cancel)" : "Draw on map"}
        </button>
      </div>

      {drawn && (
        <div className="cp-region-draft">
          <p>
            <strong>{area.toLocaleString()}</strong> pixels ·{" "}
            <code>
              {drawn.x0},{drawn.y0} → {drawn.x1},{drawn.y1}
            </code>
          </p>
          <input
            placeholder="Region name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="cp-actions">
            <button className="cp-btn cp-btn-primary" disabled={!name.trim()} onClick={() => void protect()}>
              Protect
            </button>
            <button
              className="cp-btn"
              onClick={() => {
                handle?.bbox.clear();
                setDrawn(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {error && <p className="cp-error">{error}</p>}

      <h3 className="cp-admin-sub">
        <MapPinned size={14} /> Protected ({regions?.length ?? 0})
      </h3>
      {!regions ? (
        <p className="cp-hint">Loading…</p>
      ) : regions.length === 0 ? (
        <p className="cp-hint">Nothing protected yet.</p>
      ) : (
        <ul className="cp-region-list">
          {regions.map((r) => (
            <li key={r.id}>
              <button
                className="cp-region-name"
                title="Show on map"
                onClick={() => {
                  handle?.bbox.show(r);
                  handle?.flyTo(Math.floor((r.x0 + r.x1) / 2), Math.floor((r.y0 + r.y1) / 2), 13);
                }}
              >
                {r.name}
              </button>
              <span className="cp-hint">
                {(r.x1 - r.x0 + 1)}×{(r.y1 - r.y0 + 1)}
              </span>
              <button
                className="cp-mini-danger"
                title="Remove protection"
                onClick={async () => {
                  await api.admin.removeRegion(r.id);
                  await load();
                }}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
