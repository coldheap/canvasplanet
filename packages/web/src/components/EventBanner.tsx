/**
 * The corruption event countdown (ROADMAP.md Phase 7). No local timer: the
 * server pushes a fresh `event` (via the "event" WS message) on every 1Hz
 * tick while one is active, so the store update alone re-renders this at
 * the same cadence — the countdown and bar are just derived from it.
 *
 * Lives beside App.tsx's `.cp-topbar`, not inside MapCanvas.tsx: the zone is
 * picked at random anywhere in the world, so there's no reason to expect it
 * to be on screen — clicking the banner is how you get there (same
 * `flyTo` pattern ReportsTab/RegionsTab already use for "go look at this
 * area").
 */
import { Biohazard, Crosshair } from "lucide-react";
import { EVENT_WIN_THRESHOLD, type EventStateDTO } from "@canvasplanet/shared";
import { usePhoneLayout } from "../layout.js";

/**
 * `compact` is the phone wording. The full sentence is roughly three times
 * the width of a phone banner, so there it drops the two threshold clauses
 * and the "restoring canvas" tail. Neither end condition is actually lost:
 * in compact mode the bar carries a tick at the threshold, and the banner
 * still turns red the moment it is crossed.
 */
export function eventBannerText(event: EventStateDTO, now = Date.now(), compact = false): string {
  const pctLabel = Math.round(Math.min(1, event.corruptionPct) * 100);

  if (event.status !== "active") {
    if (event.result === null) {
      return compact
        ? `Finalizing at ${pctLabel}%…`
        : `Corruption event — Finalizing result at ${pctLabel}%…`;
    }
    if (event.result === "defended") {
      return compact
        ? `Victory — defended at ${pctLabel}%`
        : `Victory — Zone defended at ${pctLabel}% corruption. Restoring canvas…`;
    }
    return compact
      ? `Defeat — lost at ${pctLabel}%`
      : `Defeat — Zone lost at ${pctLabel}% corruption. Restoring canvas…`;
  }

  const thresholdLabel = Math.round(EVENT_WIN_THRESHOLD * 100);
  const msLeft = Math.max(0, event.endsAt - now);
  const mm = Math.floor(msLeft / 60_000);
  const ss = Math.floor((msLeft % 60_000) / 1000)
    .toString()
    .padStart(2, "0");

  return compact
    ? `Corruption ${pctLabel}% · ${mm}:${ss} left`
    : `Corruption event — ${pctLabel}% corrupted · Win below ${thresholdLabel}% · Lose at ${thresholdLabel}% or more · ${mm}:${ss} left`;
}

export function EventBanner({ event, onLocate }: { event: EventStateDTO; onLocate: () => void }) {
  const phone = usePhoneLayout();
  const pct = Math.min(1, event.corruptionPct);
  const danger =
    event.result === "corrupted" || (event.result === null && event.corruptionPct >= EVENT_WIN_THRESHOLD);
  const status = eventBannerText(event, Date.now(), phone);

  return (
    <div
      className={danger ? "cp-event-banner cp-event-danger" : "cp-event-banner"}
      role="status"
      aria-live="polite"
    >
      {/* Icon and status travel together: on a phone the row wraps, and the
          biohazard mark stranded alone on the line above reads as a glitch. */}
      <span className="cp-event-head">
        <Biohazard size={15} />
        <span className="cp-event-text">{status}</span>
      </span>
      {/* Its own element rather than a tail on the status string, so the
          phone layout can wrap it down beside the bar instead of pushing
          the row to a third line. The desktop separator is CSS. */}
      {event.defenders > 0 && <span className="cp-event-defenders">{event.defenders} defending</span>}
      <div className="cp-event-bar">
        {/* Only where the wording dropped the thresholds — on a desktop
            banner that spells both of them out, a second marker for the
            same number is noise. */}
        {phone && <div className="cp-event-bar-mark" style={{ left: `${EVENT_WIN_THRESHOLD * 100}%` }} />}
        <div className="cp-event-bar-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <button className="cp-event-locate" onClick={onLocate} title="Fly to the zone">
        <Crosshair size={13} />
        Locate
      </button>
    </div>
  );
}
