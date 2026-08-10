/**
 * The leaderboard panel — the app's main progress display, and the reason
 * it is always on screen rather than behind a route.
 *
 * ROADMAP.md §5.2: player is now the primary identity, ahead of faction
 * (ex-"Alliances", ROADMAP.md §4.1) and country (the original panel,
 * ROADMAP.md v1) — the reverse of the original country-first order. The
 * three used to be two separate panels (this one and AlliancesPanel.tsx);
 * they are tabs of one panel now so switching between "how am I doing" and
 * "how is my team/country doing" doesn't cost a whole panel re-open.
 *
 * The All-time/Held toggle is shared by player and faction. Country is a
 * placement leaderboard derived from painter IPs, so it has no geographic
 * "held" concept and shows placement share instead.
 */

import { Trophy, X } from "lucide-react";
import { useState } from "react";
import { useStore } from "../store.js";
import { CountryLeaderboardTab } from "./Leaderboard.js";
import { FactionLeaderboardTab } from "./AlliancesPanel.js";
import { PlayerLeaderboardTab } from "./PlayerLeaderboardTab.js";

type Tab = "player" | "faction" | "country";

export function LeaderboardPanel() {
  const { world, setPanel } = useStore();
  const [tab, setTab] = useState<Tab>("player");
  const [mode, setMode] = useState<"cumulative" | "held">("cumulative");

  return (
    <aside className="wc-leaderboard wc-card">
      <button className="wc-modal-close" aria-label="Close" onClick={() => setPanel("none")}>
        <X size={16} />
      </button>
      <header>
        <h2 className="wc-panel-title">
          <Trophy size={16} />
          Leaderboard
        </h2>
        <span className="wc-world">{world.toLocaleString()}</span>
        <span className="wc-world-label">pixels painted</span>

        <nav className="wc-lb-tabs" role="tablist" aria-label="Leaderboard scope">
          <button role="tab" aria-selected={tab === "player"} onClick={() => setTab("player")}>
            Player
          </button>
          <button role="tab" aria-selected={tab === "faction"} onClick={() => setTab("faction")}>
            Faction
          </button>
          <button role="tab" aria-selected={tab === "country"} onClick={() => setTab("country")}>
            Country
          </button>
        </nav>

        {tab !== "country" && <div className="wc-lb-toggle" role="tablist" aria-label="Ranking metric">
          <button
            role="tab"
            aria-selected={mode === "cumulative"}
            onClick={() => setMode("cumulative")}
          >
            All-time
          </button>
          <button role="tab" aria-selected={mode === "held"} onClick={() => setMode("held")}>
            Held
          </button>
        </div>}
      </header>

      {tab === "player" && <PlayerLeaderboardTab mode={mode} />}
      {tab === "faction" && <FactionLeaderboardTab mode={mode} />}
      {tab === "country" && <CountryLeaderboardTab />}
    </aside>
  );
}
