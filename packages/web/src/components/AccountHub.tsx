import { useState } from "react";
import type { KeyboardEvent } from "react";
import { Radio, UserCircle } from "lucide-react";
import { AccountPanel } from "./AccountPanel.js";
import { DiscordIcon, DiscordPanel } from "./DiscordPanel.js";
import { StatusPanel } from "./StatusPanel.js";

type AccountSection = "profile" | "community" | "status";

export function AccountHub() {
  const [section, setSection] = useState<AccountSection>("profile");
  const sections: AccountSection[] = ["profile", "community", "status"];

  function moveTab(current: AccountSection, direction: -1 | 1): void {
    const index = sections.indexOf(current);
    const next = sections[(index + direction + sections.length) % sections.length]!;
    setSection(next);
    document.getElementById(`cp-account-tab-${next}`)?.focus();
  }

  function tabProps(id: AccountSection) {
    return {
      id: `cp-account-tab-${id}`,
      role: "tab" as const,
      "aria-selected": section === id,
      "aria-controls": `cp-account-pane-${id}`,
      tabIndex: section === id ? 0 : -1,
      onClick: () => setSection(id),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          moveTab(id, -1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          moveTab(id, 1);
        }
      },
    };
  }

  return (
    <div className="cp-account-hub">
      <div className="cp-account-tabs" role="tablist" aria-label="Account sections">
        <button {...tabProps("profile")}>
          <UserCircle size={15} />
          Profile
        </button>
        <button {...tabProps("community")}>
          <DiscordIcon size={15} />
          Discord
        </button>
        <button {...tabProps("status")}>
          <Radio size={15} />
          Status
        </button>
      </div>

      <div id={`cp-account-pane-${section}`} role="tabpanel" aria-labelledby={`cp-account-tab-${section}`}>
        {section === "profile" && <AccountPanel />}
        {section === "community" && <DiscordPanel />}
        {section === "status" && <StatusPanel />}
      </div>
    </div>
  );
}
