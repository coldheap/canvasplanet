/**
 * Settings — the panel the Admin tab sits beside.
 *
 * "Notify when full" is the single strongest retention lever available
 * without accounts: a browser notification 15 minutes after someone spends
 * their bank is what brings them back.
 */

import { Settings as SettingsIcon, ShieldCheck, Link2, Radio } from "lucide-react";
import { useStore } from "../store.js";
import { DiscordIcon } from "./DiscordPanel.js";
import { LegalFooter } from "./LegalFooter.js";

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const staff = useStore((s) => s.staff);
  const setPanel = useStore((s) => s.setPanel);

  return (
    <div className="cp-settings">
      <h2 className="cp-panel-title">
        <SettingsIcon size={16} />
        Settings
      </h2>

      <fieldset>
        <legend>Canvas</legend>
        <label>
          Grid lines
          <select
            value={settings.grid}
            onChange={(e) => updateSettings({ grid: e.target.value as never })}
          >
            <option value="auto">Auto (zoom 14+)</option>
            <option value="on">Always</option>
            <option value="off">Never</option>
          </select>
        </label>
        <Toggle
          label="Heatmap (paint density)"
          on={settings.heatmap}
          set={(heatmap) => updateSettings({ heatmap })}
        />
        <Toggle
          label="Street map overlay (OpenStreetMap)"
          on={settings.osmLayer}
          set={(osmLayer) => updateSettings({ osmLayer })}
        />
      </fieldset>

      <fieldset>
        <legend>Charges</legend>
        <Toggle label="Paint sound" on={settings.sound} set={(sound) => updateSettings({ sound })} />
        <Toggle
          label="Notify me when charges are full"
          on={settings.notifyWhenFull}
          set={async (notifyWhenFull) => {
            // Ask only when switching it ON — an unprompted permission dialog
            // on load is the fastest way to get permanently denied.
            if (notifyWhenFull && Notification.permission === "default") {
              await Notification.requestPermission();
            }
            updateSettings({ notifyWhenFull });
          }}
        />
      </fieldset>

      <fieldset>
        <legend>Appearance</legend>
        <Toggle label="Dark mode" on={settings.darkMode} set={(darkMode) => updateSettings({ darkMode })} />
        <label>
          Reduce motion
          <select
            value={settings.reduceMotion}
            onChange={(e) => updateSettings({ reduceMotion: e.target.value as never })}
          >
            <option value="system">Match system</option>
            <option value="on">Always</option>
            <option value="off">Never</option>
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Share</legend>
        <button className="cp-btn" onClick={() => void navigator.clipboard.writeText(location.href)}>
          <Link2 size={15} />
          Copy link to this view
        </button>
      </fieldset>

      <button className="cp-btn" onClick={() => setPanel("status")}>
        <Radio size={15} />
        System status
      </button>

      <button className="cp-btn" onClick={() => setPanel("discord")}>
        <DiscordIcon size={15} />
        Discord
      </button>

      {staff && (
        <button className="cp-btn cp-admin-entry" onClick={() => setPanel("admin")}>
          <ShieldCheck size={15} />
          {`Admin (${staff.role})`}
        </button>
      )}

      <LegalFooter />
    </div>
  );
}

function Toggle({
  label,
  on,
  set,
}: {
  label: string;
  on: boolean;
  set: (v: boolean) => void | Promise<void>;
}) {
  return (
    <label className="cp-toggle">
      <input type="checkbox" checked={on} onChange={(e) => void set(e.target.checked)} />
      {label}
    </label>
  );
}
