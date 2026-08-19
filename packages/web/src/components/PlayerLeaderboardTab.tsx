/**
 * The player leaderboard tab body (ROADMAP.md §5.2) — now the default tab
 * inside LeaderboardPanel.tsx, ahead of faction and country.
 *
 * Unlike a country or a faction, most sessions on day one of this feature
 * have no account at all, so there is no id to pin a "your row" on for a
 * logged-out viewer. Instead of hiding the tab's purpose from them, a
 * pinned banner sits above the ranked list inviting them to log in — the
 * decided answer to ROADMAP.md §5.2's open question about what an anonymous
 * viewer sees here.
 */

import { PLAYER_LEADERBOARD_TOP_N } from "@canvasplanet/shared";
import { Flame, LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { UserAvatar } from "./UserAvatar.js";

export function PlayerLeaderboardTab({ mode }: { mode: "cumulative" | "held" }) {
  const { playerLeaderboard, user, setPanel } = useStore();
  const [expanded, setExpanded] = useState(false);

  // [userId, displayName, cumulative, held, streakDays, avatarRevision]
  const col = mode === "cumulative" ? 2 : 3;
  const ranked = [...playerLeaderboard].sort((a, b) => b[col] - a[col]);
  const shown = expanded ? ranked : ranked.slice(0, PLAYER_LEADERBOARD_TOP_N);

  const yourIndex = user ? ranked.findIndex((r) => r[0] === user.id) : -1;
  const showPin = user !== null && yourIndex >= PLAYER_LEADERBOARD_TOP_N && !expanded;

  return (
    <>
      {user === null && (
        <div className="cp-lb-claim">
          <p>Log in to claim your spot on the player leaderboard.</p>
          <button className="cp-btn cp-btn-primary" onClick={() => setPanel("account")}>
            <LogIn size={15} />
            Log in / Sign up
          </button>
        </div>
      )}

      {ranked.length === 0 && (
        <p className="cp-hint">No players yet — be the first to sign up and paint.</p>
      )}

      <ol>
        {shown.map((row, i) => (
          <PlayerRow
            key={row[0]}
            rank={i + 1}
            value={row[col]}
            name={row[1]}
            streak={row[4]}
            avatarRevision={row[5]}
            userId={row[0]}
            you={row[0] === user?.id}
          />
        ))}
      </ol>

      {showPin && yourIndex >= 0 && (
        <div className="cp-lb-pinned">
          <PlayerRow
            rank={yourIndex + 1}
            value={ranked[yourIndex]![col]}
            name={ranked[yourIndex]![1]}
            streak={ranked[yourIndex]![4]}
            avatarRevision={ranked[yourIndex]![5]}
            userId={ranked[yourIndex]![0]}
            you
          />
        </div>
      )}

      {ranked.length > PLAYER_LEADERBOARD_TOP_N && (
        <button className="cp-lb-expand" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show all ${ranked.length}`}
        </button>
      )}
    </>
  );
}

function PlayerRow({
  rank,
  value,
  name,
  streak,
  you,
  userId,
  avatarRevision,
}: {
  rank: number;
  value: number;
  name: string;
  streak: number;
  you: boolean;
  userId: number;
  avatarRevision: string | null;
}) {
  // A brief highlight whenever the number moves, mirroring the country/
  // faction rows — the climbing count is the whole point of the panel.
  const [bump, setBump] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    if (value !== previous.current) {
      previous.current = value;
      setBump((b) => b + 1);
    }
  }, [value]);

  return (
    <li className={you ? "cp-lb-row cp-player-row cp-you" : "cp-lb-row cp-player-row"}>
      <span className="cp-rank">{rank}</span>
      <UserAvatar userId={userId} name={name} revision={avatarRevision} />
      <span className="cp-name">
        {name}
        {you && <em> (you)</em>}
      </span>
      {streak >= 2 && (
        <span className="cp-streak" title={`${streak}-day streak`}>
          <Flame size={12} />
          {streak}
        </span>
      )}
      <span key={bump} className="cp-value cp-value-bump">
        {value.toLocaleString()}
      </span>
    </li>
  );
}
