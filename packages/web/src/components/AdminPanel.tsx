/**
 * The in-app admin panel — a tab beside Settings, not a separate site.
 *
 * The 3am requirement is that this works from a phone, which is why it lives
 * in the app rather than behind SSH. It appears only when the signed-in
 * player account has been granted a staff role (an admin does this from the
 * Users tab — see StaffTab); there is no secret URL to leak into browser
 * history and nothing to discover by probing (admin routes answer 404, not
 * 403, when unauthorised).
 *
 * Mods see cleanup tools. Admins additionally see regions, stamp, staff and
 * the audit log. The server enforces the same split — this only hides what
 * would be refused anyway.
 */

import { useState } from "react";
import {
  Biohazard,
  Flag,
  Handshake,
  LogOut,
  MapPinned,
  MessageCircleWarning,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Sliders,
  Stamp,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
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
import { EventsTab } from "./admin/EventsTab.js";
import { ChatTab } from "./admin/ChatTab.js";

type Tab =
  | "control"
  | "reports"
  | "chat"
  | "revert"
  | "regions"
  | "stamp"
  | "alliances"
  | "users"
  | "events"
  | "staff"
  | "audit";

const TAB_ICON: Record<Tab, LucideIcon> = {
  control: Sliders,
  reports: Flag,
  chat: MessageCircleWarning,
  revert: RotateCcw,
  regions: MapPinned,
  stamp: Stamp,
  alliances: Handshake,
  users: UserCog,
  events: Biohazard,
  staff: Users,
  audit: ScrollText,
};

export function AdminPanel({ handle }: { handle: MapHandle | null }) {
  const staff = useStore((s) => s.staff);
  const [tab, setTab] = useState<Tab>("control");

  // Defense in depth only — SettingsPanel already hides the button that gets
  // here unless bootstrap reported a role, and every route behind this UI
  // enforces the same check server-side.
  if (!staff) return null;

  const isAdmin = staff.role === "admin";
  const tabs: Array<[Tab, string, boolean]> = [
    ["control", "Control", true],
    ["reports", "Reports", true],
    ["chat", "Chat", true],
    ["revert", "Revert", true],
    ["regions", "Regions", isAdmin],
    ["stamp", "Stamp", isAdmin],
    ["alliances", "Alliances", true],
    ["users", "Users", true],
    ["events", "Events", true],
    ["staff", "Staff", isAdmin],
    ["audit", "Audit", isAdmin],
  ];

  return (
    <div className="cp-admin">
      <header>
        <ShieldCheck size={16} />
        <strong>{staff.username}</strong>
        <span className="cp-role">{staff.role}</span>
        <button
          className="cp-mini"
          title="Log out"
          onClick={async () => {
            // There is no separate staff session to end — signing out of the
            // account is what ends admin access too.
            await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
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
      {tab === "chat" && <ChatTab />}
      {tab === "revert" && <RevertTab handle={handle} isAdmin={isAdmin} />}
      {tab === "regions" && isAdmin && <RegionsTab handle={handle} />}
      {tab === "stamp" && isAdmin && <StampTab handle={handle} />}
      {tab === "alliances" && <AlliancesTab />}
      {tab === "users" && <UsersTab isAdmin={isAdmin} />}
      {tab === "events" && <EventsTab />}
      {tab === "staff" && isAdmin && <StaffTab />}
      {tab === "audit" && isAdmin && <AuditTab />}
    </div>
  );
}
