/**
 * The world pulse: paints per second, and a ticker of the countries they
 * landed in.
 *
 * Rides entirely on the `pulse` frame the hub already broadcasts once a
 * second, so it costs no extra requests and no extra server work. The point
 * is that a canvas which is quiet in *your* viewport still looks alive —
 * without this, a new visitor to an empty region sees a dead app.
 */

import { Activity } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { CountryFlag } from "./CountryFlag.js";

export function ActivityFeed() {
  const { pps, recentFlags, countries, world } = useStore();
  const [bump, setBump] = useState(0);
  const lastWorld = useRef(world);

  // Re-trigger the count animation only when the total actually moves.
  useEffect(() => {
    if (world !== lastWorld.current) {
      lastWorld.current = world;
      setBump((b) => b + 1);
    }
  }, [world]);

  return (
    <div className="wc-pulse wc-card" aria-live="off">
      <span className={pps > 0 ? "wc-pulse-dot wc-live" : "wc-pulse-dot"} aria-hidden />
      <span className="wc-pulse-rate">
        <strong key={bump}>{pps}</strong> px/s
      </span>

      <span className="wc-pulse-flags" aria-hidden>
        {recentFlags.length === 0 ? (
          <em className="wc-hint">quiet</em>
        ) : (
          // Keyed by position, not country id: the same flag legitimately
          // appears several times and duplicate keys would drop entries.
          recentFlags.map((id, i) => (
            <CountryFlag
              key={`${i}-${id}`}
              iso={countries.get(id)?.iso_a2}
              flag={countries.get(id)?.flag}
              className="wc-pulse-flag"
            />
          ))
        )}
      </span>

      <span className="wc-pulse-total" title="Total pixels painted, all time">
        {world.toLocaleString()}
      </span>
    </div>
  );
}
