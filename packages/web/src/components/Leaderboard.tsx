/**
 * The country leaderboard tab body, one of three inside LeaderboardPanel.tsx
 * (ROADMAP.md §5.2 reordered player/faction/country; this used to be the
 * whole panel).
 *
 * The top 10, and your own country pinned below regardless of its rank.
 * "Your country" comes from your last paint, not geo-IP: no extra
 * dependency and no privacy question.
 */

import { LEADERBOARD_TOP_N } from "@worldcanvas/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { CountryFlag } from "./CountryFlag.js";

export function CountryLeaderboardTab({ mode }: { mode: "cumulative" | "held" }) {
  const { leaderboard, countries, yourCountryId } = useStore();
  const [expanded, setExpanded] = useState(false);

  const col = mode === "cumulative" ? 1 : 2;
  const ranked = [...leaderboard].sort((a, b) => b[col] - a[col]);
  const shown = expanded ? ranked : ranked.slice(0, LEADERBOARD_TOP_N);

  const yourIndex = ranked.findIndex((r) => r[0] === yourCountryId);
  const showPin = yourIndex >= LEADERBOARD_TOP_N && !expanded;

  return (
    <>
      <ol>
        {shown.map((row, i) => (
          <Row
            key={row[0]}
            rank={i + 1}
            value={row[col]}
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
            value={ranked[yourIndex]![col]}
            name={countries.get(yourCountryId!)?.name ?? "—"}
            flag={countries.get(yourCountryId!)?.flag ?? ""}
            iso={countries.get(yourCountryId!)?.iso_a2 ?? null}
            you
          />
        </div>
      )}

      {ranked.length > LEADERBOARD_TOP_N && (
        <button className="wc-lb-expand" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show all ${ranked.length}`}
        </button>
      )}
    </>
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
  const openCountryPage = useStore((s) => s.openCountryPage);
  // A brief highlight whenever the number moves. The climbing count is the
  // whole point of the panel, and a value that changes silently reads as
  // static.
  const [bump, setBump] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    if (value !== previous.current) {
      previous.current = value;
      setBump((b) => b + 1);
    }
  }, [value]);

  // International Waters has no page worth opening.
  const clickable = iso !== null && iso !== "XX";

  return (
    <li className={you ? "wc-lb-row wc-you" : "wc-lb-row"}>
      <span className="wc-rank">{rank}</span>
      <CountryFlag iso={iso} flag={flag} className="wc-flag" />
      {clickable ? (
        <button className="wc-name wc-name-link" onClick={() => openCountryPage(iso)}>
          {name}
          {you && <em> (you)</em>}
        </button>
      ) : (
        <span className="wc-name">
          {name}
          {you && <em> (you)</em>}
        </span>
      )}
      <span key={bump} className="wc-value wc-value-bump">
        {value.toLocaleString()}
      </span>
    </li>
  );
}
