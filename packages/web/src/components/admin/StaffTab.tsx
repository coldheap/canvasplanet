/**
 * Staff overview — who currently holds a role, and a place to revoke it.
 *
 * Granting is done from the Users tab, next to the account it applies to
 * (search for the person, then pick a role) — there's no separate staff
 * signup here, because staff is just a role on an existing player account.
 *
 * Revoking takes effect immediately: there is no separate staff session to
 * end, so the next request from that account simply stops carrying it.
 */

import { useEffect, useState } from "react";
import { ShieldCheck, UserMinus } from "lucide-react";
import { api, type StaffRow } from "../../api.js";
import { useStore } from "../../store.js";

export function StaffTab() {
  const me = useStore((s) => s.staff);
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.admin.staff().then(setRows).catch(() => setError("Could not load staff."));
  useEffect(() => {
    void load();
  }, []);

  return (
    <section>
      <p className="cp-hint">Grant a role from the Users tab — search for an account, then pick mod or admin.</p>
      {error && <p className="cp-error">{error}</p>}

      <h3 className="cp-admin-sub">
        <ShieldCheck size={14} /> Currently staff
      </h3>
      {!rows ? (
        <p className="cp-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="cp-hint">Nobody has a staff role.</p>
      ) : (
        <ul className="cp-staff-list">
          {rows.map((s) => {
            const isMe = s.id === me?.id;
            return (
              <li key={s.id}>
                <span className="cp-staff-name">
                  {s.username}
                  {isMe && <em className="cp-hint"> (you)</em>}
                </span>
                <span className="cp-role">{s.role}</span>
                <button
                  className="cp-mini-danger"
                  disabled={isMe}
                  title={isMe ? "You cannot revoke your own admin role" : "Revoke"}
                  onClick={async () => {
                    await api.admin.setUserRole(s.id, null);
                    await load();
                  }}
                >
                  <UserMinus size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
