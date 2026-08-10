/** Country rankings by the painter's IP-derived country. */

import { LEADERBOARD_TOP_N, type CountryDTO, type LbRow } from "@worldcanvas/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { CountryFlag } from "./CountryFlag.js";

const PIE_COLORS = ["#5b8def", "#ec6b56", "#45b69c", "#f2b84b", "#9b72cf", "#94a3b8"];

export function CountryLeaderboardTab() {
  const { leaderboard, countries, yourCountryId } = useStore();
  const [expanded, setExpanded] = useState(false);

  const ranked = [...leaderboard].filter((row) => row[1] > 0).sort((a, b) => b[1] - a[1]);
  const shown = expanded ? ranked : ranked.slice(0, LEADERBOARD_TOP_N);
  const yourIndex = ranked.findIndex((row) => row[0] === yourCountryId);
  const showPin = yourIndex >= LEADERBOARD_TOP_N && !expanded;

  if (ranked.length === 0) {
    return <p className="wc-hint wc-lb-empty">No IP-attributed country placements yet.</p>;
  }

  return (
    <>
      <p className="wc-hint wc-lb-country-note">Ranked by the painter&apos;s country, not the pixel&apos;s map location.</p>
      <CountryPieChart rows={ranked} countries={countries} />

      <ol>
        {shown.map((row, i) => (
          <Row
            key={row[0]}
            rank={i + 1}
            value={row[1]}
            name={countries.get(row[0])?.name ?? "—"}
            flag={countries.get(row[0])?.flag ?? ""}
            iso={countries.get(row[0])?.iso_a2 ?? null}
            you={row[0] === yourCountryId}
          />
        ))}
      </ol>

      {showPin && yourIndex >= 0 && (
        <div className="wc-lb-pinned">
          <Row
            rank={yourIndex + 1}
            value={ranked[yourIndex]![1]}
            name={countries.get(yourCountryId!)?.name ?? "—"}
            flag={countries.get(yourCountryId!)?.flag ?? ""}
            iso={countries.get(yourCountryId!)?.iso_a2 ?? null}
            you
          />
        </div>
      )}

      {ranked.length > LEADERBOARD_TOP_N && (
        <button className="wc-lb-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : `Show all ${ranked.length}`}
        </button>
      )}
    </>
  );
}

function CountryPieChart({
  rows,
  countries,
}: {
  rows: LbRow[];
  countries: Map<number, CountryDTO>;
}) {
  const total = rows.reduce((sum, row) => sum + row[1], 0);
  const leading = rows.slice(0, 5).map((row) => ({
    name: countries.get(row[0])?.name ?? "Unknown",
    value: row[1],
  }));
  const other = rows.slice(5).reduce((sum, row) => sum + row[1], 0);
  const slices = other > 0 ? [...leading, { name: "Other", value: other }] : leading;

  let cursor = 0;
  const stops = slices.map((slice, index) => {
    const start = cursor;
    cursor += (slice.value / total) * 100;
    return `${PIE_COLORS[index]} ${start}% ${cursor}%`;
  });

  return (
    <figure className="wc-country-pie">
      <div
        className="wc-country-pie-graphic"
        role="img"
        aria-label={`Country share of ${total.toLocaleString()} IP-attributed placements`}
        style={{ backgroundImage: `conic-gradient(${stops.join(", ")})` }}
      />
      <figcaption>
        <strong>Placement share</strong>
        <ul>
          {slices.map((slice, index) => (
            <li key={slice.name}>
              <i style={{ backgroundColor: PIE_COLORS[index] }} aria-hidden />
              <span>{slice.name}</span>
              <em>{((slice.value / total) * 100).toFixed(1)}%</em>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function Row({
  rank,
  value,
  name,
  flag,
  iso,
  you,
}: {
  rank: number;
  value: number;
  name: string;
  flag: string;
  iso: string | null;
  you: boolean;
}) {
  const [bump, setBump] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    if (value !== previous.current) {
      previous.current = value;
      setBump((current) => current + 1);
    }
  }, [value]);

  return (
    <li className={you ? "wc-lb-row wc-you" : "wc-lb-row"}>
      <span className="wc-rank">{rank}</span>
      <CountryFlag iso={iso} flag={flag} className="wc-flag" />
      <span className="wc-name">
        {name}
        {you && <em> (you)</em>}
      </span>
      <span key={bump} className="wc-value wc-value-bump" title="placements">
        {value.toLocaleString()}
      </span>
    </li>
  );
}
