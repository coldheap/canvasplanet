/**
 * "Who painted this, and when."
 *
 * Costs no extra requests: App's hover handler already fetches /api/pixel for
 * whatever is under the cursor and caches it, so this renders data that was
 * being thrown away. Hovering shows it; right-click (or long-press on touch)
 * pins it so you can move the mouse away and still read it.
 */

import { Clock, Layers, MapPin, Pin, X } from "lucide-react";
import { PALETTE, type PixelInfo } from "@worldcanvas/shared";
import { useStore } from "../store.js";
import { CountryFlag } from "./CountryFlag.js";

export function PixelInspector({
  info,
  pinned,
  onUnpin,
}: {
  info: PixelInfo;
  pinned: boolean;
  onUnpin: () => void;
}) {
  const countries = useStore((s) => s.countries);
  const country = countries.get(info.countryId);
  const swatch = info.color === null ? null : PALETTE[info.color];

  return (
    <aside className={pinned ? "wc-inspector wc-card wc-pinned" : "wc-inspector wc-card"}>
      {pinned && (
        <button className="wc-inspector-close" aria-label="Unpin" onClick={onUnpin}>
          <X size={14} />
        </button>
      )}

      <div className="wc-inspector-head">
        <span
          className="wc-inspector-swatch"
          style={{ background: swatch?.hex ?? "transparent" }}
          aria-hidden
        />
        <div>
          <strong>{swatch ? swatch.name : "Unpainted"}</strong>
          <span className="wc-inspector-coords">
            {info.x.toLocaleString()}, {info.y.toLocaleString()}
          </span>
        </div>
        {pinned && <Pin size={13} className="wc-inspector-pin" />}
      </div>

      <dl className="wc-inspector-rows">
        <div>
          <dt>
            <MapPin size={13} />
          </dt>
          <dd>
            {country ? (
              <>
                <CountryFlag iso={country.iso_a2} flag={country.flag} className="wc-inspector-flag" />{" "}
                {country.name}
              </>
            ) : (
              "—"
            )}
            <em className="wc-hint"> · {info.terrain === 1 ? "land" : "water"}</em>
          </dd>
        </div>

        {info.paintedAt && (
          <div>
            <dt>
              <Clock size={13} />
            </dt>
            <dd>{timeAgo(info.paintedAt)}</dd>
          </div>
        )}

        {info.paintCount > 1 && (
          <div>
            <dt>
              <Layers size={13} />
            </dt>
            {/* The number people actually want: how contested is this spot. */}
            <dd>painted over {info.paintCount - 1}×</dd>
          </div>
        )}
      </dl>

      {!pinned && <p className="wc-hint wc-inspector-tip">right-click to pin</p>}
    </aside>
  );
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units: Array<[number, string]> = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [30, "month"],
    [12, "year"],
  ];
  let value = seconds / 60;
  let label = "minute";
  for (let i = 1; i < units.length; i++) {
    if (value < units[i]![0]) break;
    value /= units[i]![0];
    label = units[i]![1];
  }
  const n = Math.floor(value);
  return `${n} ${label}${n === 1 ? "" : "s"} ago`;
}
