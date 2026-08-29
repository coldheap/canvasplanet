import { Users } from "lucide-react";
import "./PlayerCounter.css";

export function PlayerCounter({ count }: { count: number }) {
  const label = `${count.toLocaleString()} active ${count === 1 ? "player" : "players"}`;

  return (
    <div className="cp-player-count" role="status" aria-label={label} title={label}>
      <Users size={15} aria-hidden />
      <span>{count.toLocaleString()}</span>
    </div>
  );
}
