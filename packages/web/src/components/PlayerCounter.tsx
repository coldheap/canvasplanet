import { Users } from "lucide-react";
import "./PlayerCounter.css";

export function PlayerCounter({ count }: { count: number }) {
  const label = `${count.toLocaleString()} active ${count === 1 ? "player" : "players"}`;

  return (
    <div className="cp-player-count cp-card" role="status" aria-label={label} title={label}>
      <Users size={17} aria-hidden />
      <span>{count.toLocaleString()}</span>
    </div>
  );
}
