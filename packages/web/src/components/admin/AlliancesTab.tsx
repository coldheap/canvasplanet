/**
 * Alliance moderation — the mod-visible list from GET /api/admin/alliances,
 * same shape as StaffTab but disable/enable only: alliances are created by
 * players (AlliancesPanel.tsx), not staff, so there is no create form here.
 *
 * Disabling clears every member's alliance_id server-side (routes/admin.ts),
 * so it takes effect immediately rather than just hiding the name.
 */

import { useEffect, useState } from "react";
import { Ban, Handshake, RotateCcw } from "lucide-react";
import { api, type AdminAlliance } from "../../api.js";
import { PALETTE } from "@worldcanvas/shared";

export function AlliancesTab() {
  const [rows, setRows] = useState<AdminAlliance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.admin.alliances().then(setRows).catch(() => setError("Could not load alliances."));
  useEffect(() => {
    void load();
  }, []);

  return (
    <section>
      <h3 className="wc-admin-sub">
        <Handshake size={14} /> Alliances
      </h3>
      {error && <p className="wc-error">{error}</p>}
      {!rows ? (
        <p className="wc-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="wc-hint">No alliances have been created yet.</p>
      ) : (
        <ul className="wc-staff-list">
          {rows.map((a) => {
            const disabled = a.disabled_at !== null;
            return (
              <li key={a.id} className={disabled ? "wc-staff-off" : undefined}>
                <span
                  className="wc-alliance-dot"
                  style={{ background: PALETTE[a.color]?.hex ?? "#888" }}
                />
                <span className="wc-staff-name">{a.name}</span>
                <span className="wc-role">{a.members} member{a.members === 1 ? "" : "s"}</span>
                <button
                  className={disabled ? "wc-mini" : "wc-mini-danger"}
                  title={disabled ? "Re-enable" : "Disable"}
                  onClick={async () => {
                    await api.admin.setAllianceDisabled(a.id, !disabled);
                    await load();
                  }}
                >
                  {disabled ? <RotateCcw size={13} /> : <Ban size={13} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
