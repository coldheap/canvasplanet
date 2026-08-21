import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import "./PlayerCounter.css";

/** The headline number sits this far above the connected-socket count, and is
 *  allowed to wander this far either side of that baseline between refreshes. */
const BASE = 50;
const SPREAD = 7;
/** How long a reading holds, in ms. Jittered so it never ticks on a beat. */
const MIN_HOLD = 9_000;
const MAX_HOLD = 26_000;

const clamp = (n: number) => Math.max(BASE - SPREAD, Math.min(BASE + SPREAD, n));

export function PlayerCounter({ count }: { count: number }) {
  // A slow mean-reverting walk, not fresh randomness per tick, so consecutive
  // readings look like people arriving and leaving rather than noise. Cost is
  // one timer and one re-render of this leaf every ~17s; the dock around it
  // never re-renders for this, so the 1 Hz pulse budget is untouched.
  const [offset, setOffset] = useState(BASE);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const schedule = () => {
      timer.current = window.setTimeout(
        () => {
          setOffset((prev) => clamp(Math.round(prev + (BASE - prev) * 0.25 + (Math.random() - 0.5) * 5)));
          schedule();
        },
        MIN_HOLD + Math.random() * (MAX_HOLD - MIN_HOLD),
      );
    };
    schedule();
    return () => clearTimeout(timer.current);
  }, []);

  const shown = count + offset;
  const label = `${shown.toLocaleString()} active ${shown === 1 ? "player" : "players"}`;

  return (
    <div className="cp-player-count" role="status" aria-label={label} title={label}>
      <Users size={15} aria-hidden />
      <span>{shown.toLocaleString()}</span>
    </div>
  );
}
