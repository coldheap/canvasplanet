/**
 * The in-app admin panel — a tab beside Settings, not a separate site.
 *
 * The 3am requirement is that this works from a phone, which is why it lives
 * in the app rather than behind SSH. It appears only when /api/bootstrap
 * reports a staff session; there is no secret URL to leak into browser
 * history and nothing to discover by probing (admin routes answer 404, not
 * 403, when unauthorised).
 *
 * Mods see cleanup tools. Admins additionally see regions, stamp, staff and
 * the audit log. The server enforces the same split — this only hides what
 * would be refused anyway.
 */

import { useState } from "react";
import {
  AlertOctagon,
  Flag,
  Handshake,
  LogIn,
  LogOut,
  MapPinned,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Sliders,
  Stamp,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { MapHandle } from "./MapCanvas.js";
import { ControlTab } from "./admin/ControlTab.js";
import { RevertTab } from "./admin/RevertTab.js";
import { RegionsTab } from "./admin/RegionsTab.js";
import { ReportsTab } from "./admin/ReportsTab.js";
import { StampTab } from "./admin/StampTab.js";
import { StaffTab } from "./admin/StaffTab.js";
import { AuditTab } from "./admin/AuditTab.js";
import { AlliancesTab } from "./admin/AlliancesTab.js";
import { UsersTab } from "./admin/UsersTab.js";

type Tab =
  | "control"
  | "reports"
  | "revert"
  | "regions"
  | "stamp"
  | "alliances"
  | "users"
  | "staff"
  | "audit";

const TAB_ICON: Record<Tab, LucideIcon> = {
  control: Sliders,
  reports: Flag,
  revert: RotateCcw,
  regions: MapPinned,
  stamp: Stamp,
  alliances: Handshake,
  users: UserCog,
  staff: Users,
  audit: ScrollText,
};

export function AdminPanel({ handle }: { handle: MapHandle | null }) {
  const staff = useStore((s) => s.staff);
  const [tab, setTab] = useState<Tab>("control");

  if (!staff) return <StaffLogin />;

  const isAdmin = staff.role === "admin";
  const tabs: Array<[Tab, string, boolean]> = [
    ["control", "Control", true],
    ["reports", "Reports", true],
    ["revert", "Revert", true],
    ["regions", "Regions", isAdmin],
    ["stamp", "Stamp", isAdmin],
    ["alliances", "Alliances", true],
    ["users", "Users", true],
    ["staff", "Staff", isAdmin],
    ["audit", "Audit", isAdmin],
  ];

  return (
    <div className="wc-admin">
      <header>
        <ShieldCheck size={16} />
        <strong>{staff.username}</strong>
        <span className="wc-role">{staff.role}</span>
        <button
          className="wc-mini"
          title="Sign out"
          onClick={async () => {
            await fetch("/api/staff/logout", { method: "POST", credentials: "same-origin" });
            location.reload();
          }}
        >
          <LogOut size={13} />
        </button>
      </header>

      <nav>
        {tabs
          .filter(([, , allowed]) => allowed)
          .map(([id, label]) => {
            const Icon = TAB_ICON[id];
            return (
              <button key={id} aria-selected={tab === id} onClick={() => setTab(id)}>
                <Icon size={13} />
                {label}
              </button>
            );
          })}
      </nav>

      {tab === "control" && <ControlTab isAdmin={isAdmin} />}
      {tab === "reports" && <ReportsTab handle={handle} />}
      {tab === "revert" && <RevertTab handle={handle} isAdmin={isAdmin} />}
      {tab === "regions" && isAdmin && <RegionsTab handle={handle} />}
      {tab === "stamp" && isAdmin && <StampTab handle={handle} />}
      {tab === "alliances" && <AlliancesTab />}
      {tab === "users" && <UsersTab />}
      {tab === "staff" && isAdmin && <StaffTab />}
      {tab === "audit" && isAdmin && <AuditTab />}
    </div>
  );
}

function StaffLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await api.staffLogin(username, password);
      // Reload rather than patching state: the staff cookie changes what
      // /api/bootstrap returns, and re-bootstrapping from scratch is the
      // one path guaranteed to be consistent.
      location.reload();
    } catch {
      setError("Incorrect username or password.");
      setBusy(false);
    }
  }

  return (
    <form className="wc-staff-login" onSubmit={(e) => void submit(e)}>
      <h2 className="wc-panel-title">
        <ShieldCheck size={16} />
        Staff sign in
      </h2>
      <input
        autoComplete="username"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="wc-btn wc-btn-primary" disabled={busy}>
        <LogIn size={15} />
        Sign in
      </button>
      {error && (
        <p className="wc-error">
          <AlertOctagon size={14} />
          {error}
        </p>
      )}
    </form>
  );
}
