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

  if (error) return <p className="cp-error">{error}</p>;
  if (!data) {
    return (
      <p className="cp-hint cp-loading">
        <Loader2 size={15} className="cp-spin" /> Loading…
      </p>
    );
  }

  return (
    <div className="cp-country">
      <h2 className="cp-panel-title">
        <CountryFlag iso={iso} flag={data.flag} className="cp-country-flag" />
        {data.name}
      </h2>

      <div className="cp-country-stats">
        <div>
          <span className="cp-country-value">{data.cumulative.toLocaleString()}</span>
          <span className="cp-hint">all-time</span>
        </div>
        <div>
          <span className="cp-country-value">{data.held.toLocaleString()}</span>
          <span className="cp-hint">held now</span>
        </div>
        <div>
          <span className="cp-country-value">
            {data.rank === null ? "—" : `#${data.rank}`}
          </span>
          <span className="cp-hint">
            <Trophy size={12} /> rank
          </span>
        </div>
      </div>

      {data.hotspot ? (
        <button
          className="cp-btn cp-btn-primary"
          onClick={() => {
            onFlyTo(data.hotspot!.x, data.hotspot!.y);
            setPanel("none");
          }}
        >
          <Crosshair size={15} />
          Fly to busiest area
          <em className="cp-hint"> · {data.hotspot.paints.toLocaleString()} in 24h</em>
        </button>
      ) : (
        <p className="cp-hint">No activity here in the last 24 hours.</p>
      )}

      {data.subdivisions.length === 0 ? (
        <p className="cp-hint cp-country-note">Regional breakdown is not available yet.</p>
      ) : (
        <>
          <h3 className="cp-admin-sub">
            <MapPin size={14} /> Busiest regions
          </h3>
          <ul className="cp-ip-list">
            {data.subdivisions.map((s) => (
              <li key={s.name}>
                <span>{s.name}</span>
                <span className="cp-ip-count">{s.cumulative.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
