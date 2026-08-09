/**
 * A country's page: totals, rank, and where its activity actually is.
 *
 * Reachable by clicking any leaderboard row. The "fly to hotspot" button is
 * the point — the leaderboard tells you a country is busy, this takes you to
 * the part of the map where that is happening. Without it the board is a
 * scoreboard you can only read.
 */

import { useEffect, useState } from "react";
import { Crosshair, Loader2, MapPin, Trophy } from "lucide-react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { CountryFlag } from "./CountryFlag.js";

interface CountryDetail {
  id: number;
  name: string;
  flag: string;
  cumulative: number;
  held: number;
  rank: number | null;
  hotspot: { x: number; y: number; paints: number } | null;
  subdivisions: Array<{ name: string; cumulative: number }>;
}

export function CountryPage({
  iso,
  onFlyTo,
}: {
  iso: string;
  onFlyTo: (x: number, y: number) => void;
}) {
  const [data, setData] = useState<CountryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setPanel = useStore((s) => s.setPanel);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .country(iso)
      .then((d) => {
        if (!cancelled) setData(d as unknown as CountryDetail);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load that country.");
      });
    return () => {
      cancelled = true;
    };
  }, [iso]);

  if (error) return <p className="wc-error">{error}</p>;
  if (!data) {
    return (
      <p className="wc-hint wc-loading">
        <Loader2 size={15} className="wc-spin" /> Loading…
      </p>
    );
  }

  return (
    <div className="wc-country">
      <h2 className="wc-panel-title">
        <CountryFlag iso={iso} flag={data.flag} className="wc-country-flag" />
        {data.name}
      </h2>

      <div className="wc-country-stats">
        <div>
          <span className="wc-country-value">{data.cumulative.toLocaleString()}</span>
          <span className="wc-hint">all-time</span>
        </div>
        <div>
          <span className="wc-country-value">{data.held.toLocaleString()}</span>
          <span className="wc-hint">held now</span>
        </div>
        <div>
          <span className="wc-country-value">
            {data.rank === null ? "—" : `#${data.rank}`}
          </span>
          <span className="wc-hint">
            <Trophy size={12} /> rank
          </span>
        </div>
      </div>

      {data.hotspot ? (
        <button
          className="wc-btn wc-btn-primary"
          onClick={() => {
            onFlyTo(data.hotspot!.x, data.hotspot!.y);
            setPanel("none");
          }}
        >
          <Crosshair size={15} />
          Fly to busiest area
          <em className="wc-hint"> · {data.hotspot.paints.toLocaleString()} in 24h</em>
        </button>
      ) : (
        <p className="wc-hint">No activity here in the last 24 hours.</p>
      )}

      {data.subdivisions.length === 0 ? (
        <p className="wc-hint wc-country-note">Regional breakdown is not available yet.</p>
      ) : (
        <>
          <h3 className="wc-admin-sub">
            <MapPin size={14} /> Busiest regions
          </h3>
          <ul className="wc-ip-list">
            {data.subdivisions.map((s) => (
              <li key={s.name}>
                <span>{s.name}</span>
                <span className="wc-ip-count">{s.cumulative.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
