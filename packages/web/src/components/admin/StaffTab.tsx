/**
 * Staff accounts.
 *
 * Passwords are hashed server-side with argon2id; this form never sends
 * anything but the plaintext over the already-TLS connection, and the server
 * refuses a pre-hashed value by design.
 *
 * Disabling an account also deletes its sessions server-side, so it takes
 * effect immediately rather than at next login.
 */

import { useEffect, useState } from "react";
import { ShieldCheck, UserMinus, UserPlus, UserCheck } from "lucide-react";
import { api, type StaffRow } from "../../api.js";
import { useStore } from "../../store.js";

export function StaffTab() {
  const me = useStore((s) => s.staff);
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"mod" | "admin">("mod");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.admin.staff().then(setRows).catch(() => setError("Could not load staff."));
  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.admin.addStaff({ username: username.trim(), password, role });
      setUsername("");
      setPassword("");
      await load();
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not create that account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <form className="wc-staff-form" onSubmit={(e) => void create(e)}>
        <input
          placeholder="Username"
          value={username}
          autoComplete="off"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password (12+ characters)"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as "mod" | "admin")}>
          <option value="mod">Mod — revert, ban, inspect</option>
          <option value="admin">Admin — everything</option>
        </select>
        <button className="wc-btn wc-btn-primary" type="submit" disabled={busy}>
          <UserPlus size={15} />
          Create
        </button>
      </form>
      {error && <p className="wc-error">{error}</p>}

      <h3 className="wc-admin-sub">
        <ShieldCheck size={14} /> Accounts
      </h3>
      {!rows ? (
        <p className="wc-hint">Loading…</p>
      ) : (
        <ul className="wc-staff-list">
          {rows.map((s) => {
            const isMe = s.id === me?.id;
            const disabled = s.disabled_at !== null;
            return (
              <li key={s.id} className={disabled ? "wc-staff-off" : undefined}>
                <span className="wc-staff-name">
                  {s.username}
                  {isMe && <em className="wc-hint"> (you)</em>}
                </span>
                <span className="wc-role">{s.role}</span>
                {/* Locking yourself out mid-incident is not recoverable from
                    inside the panel, so the server refuses it too. */}
                <button
                  className={disabled ? "wc-mini" : "wc-mini-danger"}
                  disabled={isMe}
                  title={isMe ? "You cannot disable your own account" : disabled ? "Re-enable" : "Disable"}
                  onClick={async () => {
                    await api.admin.setStaffDisabled(s.id, !disabled);
                    await load();
                  }}
                >
                  {disabled ? <UserCheck size={13} /> : <UserMinus size={13} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
