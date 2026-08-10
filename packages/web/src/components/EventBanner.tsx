/**
 * The corruption event countdown (ROADMAP.md Phase 7). No local timer: the
 * server pushes a fresh `event` (via the "event" WS message) on every 1Hz
 * tick while one is active, so the store update alone re-renders this at
 * the same cadence — the countdown and bar are just derived from it.
 *
 * Lives beside App.tsx's `.wc-topbar`, not inside MapCanvas.tsx: the zone is
 * picked at random anywhere in the world, so there's no reason to expect it
 * to be on screen — clicking the banner is how you get there (same
 * `flyTo` pattern ReportsTab/RegionsTab already use for "go look at this
 * area").
 */
import { Biohazard, Crosshair } from "lucide-react";
import { EVENT_WIN_THRESHOLD, type EventStateDTO } from "@worldcanvas/shared";

export function eventBannerText(event: EventStateDTO, now = Date.now()): string {
  const pct = Math.min(1, event.corruptionPct);
  const pctLabel = Math.round(pct * 100);
  const thresholdLabel = Math.round(EVENT_WIN_THRESHOLD * 100);
  const msLeft = Math.max(0, event.endsAt - now);
  const mm = Math.floor(msLeft / 60_000);
  const ss = Math.floor((msLeft % 60_000) / 1000)
    .toString()
    .padStart(2, "0");

  return (
    event.status === "active"
      ? `Corruption event — ${pctLabel}% corrupted · Win below ${thresholdLabel}% · Lose at ${thresholdLabel}% or more · ${mm}:${ss} left`
      : event.result === null
        ? `Corruption event — Finalizing result at ${pctLabel}%…`
        : event.result === "defended"
          ? `Victory — Zone defended at ${pctLabel}% corruption. Restoring canvas…`
          : `Defeat — Zone lost at ${pctLabel}% corruption. Restoring canvas…`
  );
}

export function EventBanner({ event, onLocate }: { event: EventStateDTO; onLocate: () => void }) {
  const pct = Math.min(1, event.corruptionPct);
  const danger =
    event.result === "corrupted" || (event.result === null && event.corruptionPct >= EVENT_WIN_THRESHOLD);
  const status = eventBannerText(event);

  return (
    <div
      className={danger ? "wc-event-banner wc-event-danger" : "wc-event-banner"}
      role="status"
      aria-live="polite"
    >
      <Biohazard size={15} />
      <span>
        {status}
        {event.defenders > 0 ? ` · ${event.defenders} defending` : ""}
      </span>
      <div className="wc-event-bar">
        <div className="wc-event-bar-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <button className="wc-event-locate" onClick={onLocate} title="Fly to the zone">
        <Crosshair size={13} />
        Locate
      </button>
    </div>
  );
}
