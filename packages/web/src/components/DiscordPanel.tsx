import { useEffect, useState } from "react";
import { ExternalLink, Users } from "lucide-react";
import "./DiscordPanel.css";

const DISCORD_WIDGET_URL = "https://discord.com/api/guilds/1536474028116676760/widget.json";
const DISCORD_INVITE_URL = "https://discord.gg/GyXxx5Y3Tq";
const VISIBLE_MEMBERS = 8;

interface DiscordMember {
  id: string;
  username: string;
  avatar_url: string;
  status: "online" | "idle" | "dnd" | "offline";
}

interface DiscordWidget {
  id: string;
  name: string;
  presence_count: number;
  members: DiscordMember[];
}

export function DiscordIcon({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 127.14 96.36"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-9.39 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 9.39 105.25 105.25 0 0 0 32.17-16.14c2.64-27.38-4.51-51.11-18.88-72.16ZM42.45 65.69c-6.27 0-11.45-5.73-11.45-12.79s5.06-12.8 11.45-12.8S54 45.88 53.89 52.9c0 7.06-5.06 12.79-11.44 12.79Zm42.24 0c-6.28 0-11.44-5.73-11.44-12.79S78.31 40.1 84.69 40.1s11.54 5.78 11.43 12.8c0 7.06-5.05 12.79-11.43 12.79Z" />
    </svg>
  );
}

export function DiscordPanel() {
  const [widget, setWidget] = useState<DiscordWidget | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void fetch(DISCORD_WIDGET_URL, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Discord widget returned ${response.status}`);
        return response.json() as Promise<DiscordWidget>;
      })
      .then((data) => setWidget(data))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });

    return () => controller.abort();
  }, []);

  const members = widget?.members.slice(0, VISIBLE_MEMBERS) ?? [];

  return (
    <section className="wc-discord" aria-labelledby="wc-discord-title">
      <h2 id="wc-discord-title" className="wc-panel-title wc-discord-title">
        <DiscordIcon />
        {widget?.name ?? "WorldCanvas"}
      </h2>

      {widget ? (
        <>
          <div className="wc-discord-presence" role="status">
            <span className="wc-discord-live" aria-hidden />
            <strong>{widget.presence_count.toLocaleString()}</strong> online
          </div>

          {members.length > 0 && (
            <ul className="wc-discord-members" aria-label="Members online">
              {members.map((member) => (
                <li key={member.avatar_url}>
                  <span className="wc-discord-avatar">
                    <img src={member.avatar_url} alt="" width="34" height="34" loading="lazy" referrerPolicy="no-referrer" />
                    <span className={`wc-discord-status is-${member.status}`} aria-hidden />
                  </span>
                  <span className="wc-discord-member-name">{member.username}</span>
                  <span className="wc-discord-member-status">{statusLabel(member.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : failed ? (
        <div className="wc-discord-unavailable" role="status">
          <Users size={18} />
          Discord presence is unavailable right now.
        </div>
      ) : (
        <div className="wc-discord-loading" role="status" aria-label="Loading Discord members">
          <span />
          <span />
          <span />
        </div>
      )}

      <a
        className="wc-btn wc-btn-discord wc-discord-join"
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <DiscordIcon size={17} />
        Join Discord
        <ExternalLink size={14} />
      </a>
    </section>
  );
}

function statusLabel(status: DiscordMember["status"]): string {
  if (status === "dnd") return "Do not disturb";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
