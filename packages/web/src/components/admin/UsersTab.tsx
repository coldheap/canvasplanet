/**
 * Player account moderation — the ROADMAP.md §5.1 deferred piece. Same tier
 * and list shape as AlliancesTab: no create form (accounts are self-service
 * signup, not staff-created), search plus disable/enable only.
 *
 * Disabling cuts every `user_sessions` row for that account server-side
 * (routes/admin.ts), so it blocks both future logins and any already-open
 * browser tab, not just the account at next login.
 *
 * Admins additionally get a role control per row — this is also how staff
 * gets granted in the first place (see StaffTab, which only lists/revokes).
 */

import { useEffect, useRef, useState } from "react";
import { Ban, RotateCcw, Search, Trash2, UserCog } from "lucide-react";
import { api, type AdminUser } from "../../api.js";
import { UserAvatar } from "../UserAvatar.js";

export function UsersTab({ isAdmin }: { isAdmin: boolean }) {
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
        className="cp-staff-form"
        onSubmit={(e) => {
          e.preventDefault();
          void load(query);
        }}
      >
        <input
          placeholder="Search by email, display name, or Discord handle…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="cp-btn cp-btn-primary" type="submit">
          <Search size={15} />
          Search
        </button>
      </form>
      {error && <p className="cp-error">{error}</p>}

      <h3 className="cp-admin-sub">
        <UserCog size={14} /> Accounts
      </h3>
      {!rows ? (
        <p className="cp-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="cp-hint">No accounts match.</p>
      ) : (
        <ul className="cp-staff-list">
          {rows.map((u) => {
            const disabled = u.disabled_at !== null;
            // The Discord handle is what identifies a Discord-only account
            // to support — it replaces the bare "Discord only" label rather
            // than trailing it, so the ellipsis never eats the useful half.
            const contact =
              [u.email, u.discord_username && `@${u.discord_username}`].filter(Boolean).join(" · ") ||
              "Discord only";
            return (
              <li key={u.id} className={disabled ? "cp-staff-off" : undefined}>
                <UserAvatar userId={u.id} name={u.display_name} revision={u.avatar_revision} size={24} />
                <span className="cp-staff-name">
                  {u.display_name}
                  {!u.email_verified_at && <em className="cp-hint"> (unverified)</em>}
                </span>
                <span className="cp-hint" title={contact}>
                  {contact}
                </span>
                <span className="cp-role">{u.cumulative.toLocaleString()} painted</span>
                {isAdmin && (
                  <select
                    className="cp-mini-select"
                    value={u.role ?? ""}
                    title="Staff role"
                    onChange={async (e) => {
                      const role = (e.target.value || null) as "mod" | "admin" | null;
                      await api.admin.setUserRole(u.id, role);
                      await load(query);
                    }}
                  >
                    <option value="">Not staff</option>
                    <option value="mod">Mod</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
                {u.avatar_revision && (
                  <button
                    className="cp-mini-danger"
                    title="Remove profile picture"
                    aria-label={`Remove ${u.display_name}'s profile picture`}
                    onClick={async () => {
                      await api.admin.removeUserAvatar(u.id);
                      await load(query);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                <button
                  className={disabled ? "cp-mini" : "cp-mini-danger"}
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
