/**
 * The charge bank — its own floating pill at top-center, separate from the
 * colour picker below. It is a status readout, not a paint control, so it
 * stays visible regardless of zoom (unlike the palette, which locks below
 * MIN_PAINT_ZOOM).
 */

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { useStore } from "../store.js";

export function ChargeBar() {
  const bank = useStore((s) => s.bank);
  const max = useStore((s) => s.max);
  const nextAt = useStore((s) => s.nextAt);
  const regenMs = useStore((s) => s.regenMs);
  // The whole settings object would re-render this on any unrelated toggle.
  const notifyWhenFull = useStore((s) => s.settings.notifyWhenFull);
  const regenerateLocally = useStore((s) => s.regenerateLocally);
  const seconds = useCountdown(nextAt, regenMs, regenerateLocally);

  // Ask once, when the bank fills, if the user opted in. This is the single
  // strongest retention lever available without accounts.
  useEffect(() => {
    if (!notifyWhenFull || bank < max) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification("CanvasPlanet", {
      body: `Your ${max} charges are ready.`,
      icon: "/logo.png",
      badge: "/logo.png",
    });
  }, [bank, max, notifyWhenFull]);

  // Continuous fill: whole charges plus how far into the next one we are, so
  // the bar creeps forward every second instead of jumping in 1/max steps.
  const partial = seconds === null ? 0 : 1 - (seconds * 1000) / regenMs;
  const pct = ((bank + Math.max(0, Math.min(1, partial))) / max) * 100;

  return (
    <div className="cp-charge-pill cp-card">
      <Zap size={14} />
      <div className="cp-charge-bar">
        <div className="cp-charge-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="cp-charge-count">
        {bank}
        <span className="cp-charge-count-max">/{max}</span>
      </span>
      <span className="cp-charge-timer">
        {bank >= max ? "Full" : seconds !== null ? `+1 in ${seconds}s` : "Recharging"}
      </span>
    </div>
  );
}

/**
 * Ticks once a second. Returns the seconds left, or null when nothing is
 * pending.
 *
 * The server only pushes a "charges" message on connect and after a spend —
 * there is no periodic broadcast while a client sits idle — so once the
 * countdown lands, the store advances the balance locally rather than waiting
 * for a push that never comes. The arithmetic lives there because it has to
 * be done against the settled balance, not the one on screen.
 */
function useCountdown(
  nextAt: number | null,
  regenMs: number,
  regenerateLocally: () => void,
): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (nextAt === null) return;
    const id = window.setInterval(() => {
      if (Date.now() < nextAt) force((n) => n + 1);
      else regenerateLocally();
    }, 1000);
    return () => window.clearInterval(id);
  }, [nextAt, regenMs, regenerateLocally]);

  if (nextAt === null) return null;
  return Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
}
