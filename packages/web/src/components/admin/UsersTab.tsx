/**
 * Player account moderation — the ROADMAP.md §5.1 deferred piece. Same tier
 * and list shape as AlliancesTab: no create form (accounts are self-service
 * signup, not staff-created), search plus disable/enable only.
 *
 * Disabling cuts every `user_sessions` row for that account server-side
 * (routes/admin.ts), so it blocks both future logins and any already-open
 * browser tab, not just the account at next login.
 */

import { useEffect, useRef, useState } from "react";
import { Ban, RotateCcw, Search, UserCog } from "lucide-react";
import { api, type AdminUser } from "../../api.js";

export function UsersTab() {
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The initial unfiltered load and a search can resolve out of order (a
  // search over a handful of matches easily beats the full unfiltered query
  // back) — a request id guards against the slower response clobbering the
  // newer one.
  const requestId = useRef(0);

  const load = (q: string) => {
    const id = ++requestId.current;
    return api.admin
      .users(q)
      .then((r) => {
        if (id === requestId.current) setRows(r);
      })
      .catch(() => {
        if (id === requestId.current) setError("Could not load users.");
      });
  };
  useEffect(() => {
    void load("");
  }, []);

  return (
    <section>
      <form
        className="wc-staff-form"
        onSubmit={(e) => {
          e.preventDefault();
          void load(query);
        }}
      >
        <input
          placeholder="Search by email or display name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="wc-btn wc-btn-primary" type="submit">
          <Search size={15} />
          Search
        </button>
      </form>
      {error && <p className="wc-error">{error}</p>}

      <h3 className="wc-admin-sub">
        <UserCog size={14} /> Accounts
      </h3>
      {!rows ? (
        <p className="wc-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="wc-hint">No accounts match.</p>
      ) : (
        <ul className="wc-staff-list">
          {rows.map((u) => {
            const disabled = u.disabled_at !== null;
            return (
              <li key={u.id} className={disabled ? "wc-staff-off" : undefined}>
                <span className="wc-staff-name">
                  {u.display_name}
                  {!u.email_verified_at && <em className="wc-hint"> (unverified)</em>}
                </span>
                <span className="wc-hint">{u.email ?? "Discord only"}</span>
                <span className="wc-role">{u.cumulative.toLocaleString()} painted</span>
                <button
                  className={disabled ? "wc-mini" : "wc-mini-danger"}
                  title={disabled ? "Re-enable" : "Disable"}
                  onClick={async () => {
                    await api.admin.setUserDisabled(u.id, !disabled);
                    await load(query);
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
