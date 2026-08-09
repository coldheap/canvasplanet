/**
 * The charge bank — its own floating pill at top-center, separate from the
 * colour picker below. It is a status readout, not a paint control, so it
 * stays visible regardless of zoom (unlike the palette, which locks below
 * MIN_PAINT_ZOOM).
 */

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { CHARGE_REGEN_MS } from "@worldcanvas/shared";
import { useStore } from "../store.js";

export function ChargeBar() {
  const { bank, max, nextAt, settings, setBank } = useStore();
  const seconds = useCountdown(bank, max, nextAt, setBank);

  // Ask once, when the bank fills, if the user opted in. This is the single
  // strongest retention lever available without accounts.
  useEffect(() => {
    if (!settings.notifyWhenFull || bank < max) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification("Worldcanvas", { body: `Your ${max} charges are ready.` });
  }, [bank, max, settings.notifyWhenFull]);

  // Continuous fill: whole charges plus how far into the next one we are, so
  // the bar creeps forward every second instead of jumping in 1/max steps.
  const partial = seconds === null ? 0 : 1 - (seconds * 1000) / CHARGE_REGEN_MS;
  const pct = ((bank + Math.max(0, Math.min(1, partial))) / max) * 100;

  return (
    <div className="wc-charge-pill wc-card">
      <Zap size={14} />
      <div className="wc-charge-bar">
        <div className="wc-charge-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="wc-charge-count">
        {bank}
        <span className="wc-charge-count-max">/{max}</span>
      </span>
      <span className="wc-charge-timer">{seconds !== null ? `+1 in ${seconds}s` : "Full"}</span>
    </div>
  );
}

/**
 * Ticks once a second. Returns null when the bank is full.
 *
 * The server only pushes a "charges" message on connect and after a spend —
 * there is no periodic broadcast while a client sits idle. So once the
 * countdown lands, this advances the bank locally (catching up on however
 * many periods actually elapsed, in case the tab was throttled in the
 * background) rather than waiting for a push that never comes.
 */
function useCountdown(
  bank: number,
  max: number,
  nextAt: number | null,
  setBank: (bank: number, nextAt: number | null) => void,
): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (nextAt === null) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      if (now < nextAt) {
        force((n) => n + 1);
        return;
      }
      const gained = Math.min(max - bank, 1 + Math.floor((now - nextAt) / CHARGE_REGEN_MS));
      const newBank = bank + gained;
      setBank(newBank, newBank >= max ? null : nextAt + gained * CHARGE_REGEN_MS);
    }, 1000);
    return () => window.clearInterval(id);
  }, [nextAt, bank, max, setBank]);

  if (nextAt === null) return null;
  return Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
}
