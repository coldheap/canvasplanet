/**
 * The faction (alliance) leaderboard tab body, one of three inside
 * LeaderboardPanel.tsx (ROADMAP.md §5.2 reordered player/faction/country;
 * this used to be its own panel, "Alliances" — ROADMAP.md §4.1). Country
 * rivalry is the built-in hook (Leaderboard.tsx); this is the same idea for
 * communities that are not a country.
 *
 * Unlike the country leaderboard, the list of alliances itself changes at
 * runtime, so this re-fetches it on mount rather than trusting only what
 * bootstrap saw — the live "alb" stats frame (via the store) keeps numbers
 * current between fetches, same as "lb" does for countries.
 */

import { useEffect, useState } from "react";
import { Check, Handshake, LogOut, Plus } from "lucide-react";
import { ALLIANCE_LEADERBOARD_TOP_N, PALETTE } from "@canvasplanet/shared";
import { api } from "../api.js";
import { useStore } from "../store.js";

export function FactionLeaderboardTab({ mode }: { mode: "cumulative" | "held" }) {
  const alliances = useStore((s) => s.alliances);
  const allianceLeaderboard = useStore((s) => s.allianceLeaderboard);
  const yourAllianceId = useStore((s) => s.yourAllianceId);
  const setAlliances = useStore((s) => s.setAlliances);
  const setYourAlliance = useStore((s) => s.setYourAlliance);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(0);
  const [busy, setBusy] = useState<number | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.alliances().then((r) => setAlliances(r.alliances, r.rows));
  }, [setAlliances]);

  const byId = new Map(alliances.map((a) => [a.id, a]));
  const col = mode === "cumulative" ? 1 : 2;
  const ranked = [...allianceLeaderboard].filter((r) => byId.has(r[0])).sort((a, b) => b[col] - a[col]);
  const shown = expanded ? ranked : ranked.slice(0, ALLIANCE_LEADERBOARD_TOP_N);
  const yourIndex = ranked.findIndex((r) => r[0] === yourAllianceId);
  const showPin = yourIndex >= ALLIANCE_LEADERBOARD_TOP_N && !expanded;

  async function join(id: number): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await api.joinAlliance(id);
      setYourAlliance(id);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not join that alliance.");
    } finally {
      setBusy(null);
    }
  }

  async function leave(): Promise<void> {
    setBusy(yourAllianceId);
    setError(null);
    try {
      await api.leaveAlliance();
      setYourAlliance(null);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not leave that alliance.");
    } finally {
      setBusy(null);
    }
  }

  async function create(): Promise<void> {
    setBusy("create");
    setError(null);
    try {
      const created = await api.createAlliance({ name: name.trim(), color });
      setAlliances([...alliances, created], allianceLeaderboard);
      setYourAlliance(created.id);
      setCreating(false);
      setName("");
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not create that alliance.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {ranked.length === 0 && !creating && (
        <p className="cp-hint">No alliances yet — be the first to start one.</p>
      )}

      <ol>
        {shown.map((row, i) => (
          <AllianceRow
            key={row[0]}
            rank={i + 1}
            value={row[col]}
            name={byId.get(row[0])?.name ?? "—"}
            color={byId.get(row[0])?.color ?? 0}
            you={row[0] === yourAllianceId}
            busy={busy === row[0]}
            onJoin={yourAllianceId === null ? () => void join(row[0]) : undefined}
            onLeave={row[0] === yourAllianceId ? () => void leave() : undefined}
          />
        ))}
      </ol>

      {showPin && yourIndex >= 0 && (
        <div className="cp-lb-pinned">
          <AllianceRow
            rank={yourIndex + 1}
            value={ranked[yourIndex]![col]}
            name={byId.get(yourAllianceId!)?.name ?? "—"}
            color={byId.get(yourAllianceId!)?.color ?? 0}
            you
            busy={busy === yourAllianceId}
            onLeave={() => void leave()}
          />
        </div>
      )}

      {ranked.length > ALLIANCE_LEADERBOARD_TOP_N && (
        <button className="cp-lb-expand" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show all ${ranked.length}`}
        </button>
      )}

      {error && <p className="cp-error">{error}</p>}

      {creating ? (
        <div className="cp-alliance-create">
          <input
            placeholder="Alliance name"
            maxLength={32}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <div className="cp-swatches">
            <div className="cp-swatch-group">
              {PALETTE.map((s) => (
                <button
                  key={s.i}
                  className={s.i === color ? "cp-swatch cp-on" : "cp-swatch"}
                  style={{ background: s.hex }}
                  title={s.name}
                  aria-label={s.name}
                  aria-pressed={s.i === color}
                  onClick={() => setColor(s.i)}
                />
              ))}
            </div>
          </div>
          <div className="cp-actions">
            <button
              className="cp-btn cp-btn-primary"
              disabled={name.trim().length < 3 || busy === "create"}
              onClick={() => void create()}
            >
              <Check size={15} />
              Create
            </button>
            <button className="cp-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="cp-btn cp-admin-entry" onClick={() => setCreating(true)}>
          <Plus size={15} />
          Start an alliance
        </button>
      )}
    </>
  );
}

function AllianceRow({
  rank,
  value,
  name,
  color,
  you,
  busy,
  onJoin,
  onLeave,
}: {
  rank: number;
  value: number;
  name: string;
  color: number;
  you: boolean;
  busy: boolean;
  onJoin?: () => void;
  onLeave?: () => void;
}) {
  const hex = PALETTE[color]?.hex ?? "#888";
  return (
    <li className={you ? "cp-lb-row cp-alliance-row cp-you" : "cp-lb-row cp-alliance-row"}>
      <span className="cp-rank">{rank}</span>
      <span className="cp-alliance-dot" style={{ background: hex }} />
      <span className="cp-name">
        {name}
        {you && <em> (you)</em>}
      </span>
      <span className="cp-value">{value.toLocaleString()}</span>
      {onLeave && (
        <button className="cp-mini-danger" title="Leave" disabled={busy} onClick={onLeave}>
          <LogOut size={13} />
        </button>
      )}
      {onJoin && (
        <button className="cp-mini" title="Join" disabled={busy} onClick={onJoin}>
          <Handshake size={13} />
        </button>
      )}
    </li>
  );
}
