/**
 * The audit log.
 *
 * Every mutating admin action writes here. "Who froze the canvas?" and "who
 * reverted Brazil?" must always have an answer — that is the entire point of
 * having named staff accounts rather than one shared key.
 */

import { useEffect, useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { api, type AuditRow } from "../../api.js";

const ACTION_LABEL: Record<string, string> = {
  revert: "reverted",
  stamp: "stamped",
  freeze: "froze / unfroze",
  ban: "banned",
  "region.add": "protected a region",
  "region.remove": "unprotected a region",
  "staff.create": "created an account",
  "staff.disable": "disabled an account",
};

export function AuditTab() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [who, setWho] = useState("");

  useEffect(() => {
    api.admin.audit().then(setRows).catch(() => setRows([]));
  }, []);

  const staffNames = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.username).filter(Boolean))] as string[],
    [rows],
  );
  const shown = (rows ?? []).filter((r) => !who || r.username === who);

  return (
    <section>
      {staffNames.length > 1 && (
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Everyone</option>
          {staffNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}

      <h3 className="cp-admin-sub">
        <ScrollText size={14} /> Recent actions
      </h3>

      {!rows ? (
        <p className="cp-hint">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="cp-hint">Nothing logged yet.</p>
      ) : (
        <ol className="cp-audit-list">
          {shown.map((r) => (
            <li key={r.id}>
              <div className="cp-audit-head">
                <strong>{r.username ?? "unknown"}</strong>
                <span>{ACTION_LABEL[r.action] ?? r.action}</span>
                {r.affected !== null && (
                  <em className="cp-hint">{r.affected.toLocaleString()} pixels</em>
                )}
              </div>
              <div className="cp-audit-meta">
                <time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time>
                {/* The raw params are the difference between "someone
                    reverted something" and being able to reconstruct it. */}
                <code>{summarise(r.params)}</code>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Compact one-line rendering of an action's parameters. */
function summarise(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === null || v === undefined) continue;
    if (k === "bbox" && typeof v === "object") {
      const b = v as Record<string, number>;
      parts.push(`bbox ${b.x0},${b.y0}→${b.x1},${b.y1}`);
    } else if (k === "since" && typeof v === "number") {
      parts.push(`since ${new Date(v).toLocaleTimeString()}`);
    } else if (typeof v !== "object") {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join("  ") || "—";
}
