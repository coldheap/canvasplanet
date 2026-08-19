import { useEffect, useState } from "react";
import { Check, MessageCircleWarning, Shield, Trash2, Volume2 } from "lucide-react";
import { api, type AdminChatMute, type AdminChatReport } from "../../api.js";
import { ChatAvatar } from "../ChatPanel.js";

type Status = "open" | "all";

function errorMessage(error: unknown, fallback: string): string {
  return (error as { body?: { error?: string } })?.body?.error ?? fallback;
}

export function ChatTab() {
  const [status, setStatus] = useState<Status>("open");
  const [reports, setReports] = useState<AdminChatReport[] | null>(null);
  const [mutes, setMutes] = useState<AdminChatMute[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muteHours, setMuteHours] = useState("24");

  function loadReports(): void {
    setReports(null);
    api.admin.chatReports(status).then(setReports).catch(() => setReports([]));
  }

  function loadMutes(): void {
    api.admin.chatMutes().then(setMutes).catch(() => setMutes([]));
  }

  useEffect(loadReports, [status]);
  useEffect(loadMutes, []);

  async function remove(report: AdminChatReport): Promise<void> {
    setBusy(`delete-${report.id}`);
    setError(null);
    try {
      await api.admin.deleteChatMessage(report.message_id, report.reason ?? "chat report");
      loadReports();
    } catch (error) {
      setError(errorMessage(error, "Could not remove that message."));
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(report: AdminChatReport): Promise<void> {
    setBusy(`dismiss-${report.id}`);
    setError(null);
    try {
      await api.admin.resolveChatReport(report.id, "dismissed");
      loadReports();
    } catch (error) {
      setError(errorMessage(error, "Could not dismiss that report."));
    } finally {
      setBusy(null);
    }
  }

  async function mute(report: AdminChatReport): Promise<void> {
    setBusy(`mute-${report.id}`);
    setError(null);
    try {
      await api.admin.muteChatUser(
        report.user_id,
        muteHours === "permanent" ? null : Number(muteHours),
        report.reason ?? "reported chat message",
      );
      loadMutes();
    } catch (error) {
      setError(errorMessage(error, "Could not mute that user."));
    } finally {
      setBusy(null);
    }
  }

  async function unmute(userId: number): Promise<void> {
    setBusy(`unmute-${userId}`);
    setError(null);
    try {
      await api.admin.unmuteChatUser(userId);
      loadMutes();
    } catch (error) {
      setError(errorMessage(error, "Could not remove that mute."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <div className="cp-chat-admin-controls">
        <select value={status} onChange={(event) => setStatus(event.target.value as Status)}>
          <option value="open">Open reports</option>
          <option value="all">All reports</option>
        </select>
        <select value={muteHours} onChange={(event) => setMuteHours(event.target.value)}>
          <option value="1">Mute 1 hour</option>
          <option value="24">Mute 24 hours</option>
          <option value="168">Mute 7 days</option>
          <option value="permanent">Mute permanently</option>
        </select>
      </div>

      <h3 className="cp-admin-sub"><MessageCircleWarning size={14} /> Chat reports</h3>
      {error && <p className="cp-error">{error}</p>}
      {!reports ? (
        <p className="cp-hint">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="cp-hint">No {status === "open" ? "open " : ""}chat reports.</p>
      ) : (
        <ol className="cp-chat-report-list">
          {reports.map((report) => (
            <li key={report.id} className="cp-chat-report-row">
              <ChatAvatar
                userId={report.user_id}
                name={report.display_name}
                revision={report.avatar_revision}
                size={28}
              />
              <div>
                <div className="cp-chat-report-head">
                  <strong>{report.display_name}</strong>
                  <time>{new Date(report.message_created_at).toLocaleString()}</time>
                </div>
                <p className={report.deleted_at ? "cp-chat-removed" : ""}>
                  {report.deleted_at ? "Message removed" : report.display_body}
                </p>
                <details>
                  <summary>Original moderation evidence</summary>
                  <p>{report.original_body}</p>
                </details>
                <p className="cp-hint">
                  Reported by {report.reporter_name}{report.reason ? `: ${report.reason}` : " (no reason given)"}
                </p>
                {report.resolved_at ? (
                  <span className="cp-hint">Resolved: {report.resolution ?? "reviewed"}</span>
                ) : (
                  <div className="cp-actions">
                    <button className="cp-danger" disabled={busy !== null} onClick={() => void remove(report)}>
                      <Trash2 size={13} /> Remove
                    </button>
                    <button className="cp-btn" disabled={busy !== null} onClick={() => void mute(report)}>
                      <Shield size={13} /> Mute
                    </button>
                    <button className="cp-btn" disabled={busy !== null} onClick={() => void dismiss(report)}>
                      <Check size={13} /> Dismiss
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <h3 className="cp-admin-sub"><Shield size={14} /> Active chat mutes</h3>
      {!mutes ? (
        <p className="cp-hint">Loading…</p>
      ) : mutes.length === 0 ? (
        <p className="cp-hint">Nobody is currently muted.</p>
      ) : (
        <ol className="cp-chat-mute-list">
          {mutes.map((mute) => (
            <li key={mute.id}>
              <div>
                <strong>{mute.display_name}</strong>
                <span className="cp-hint">
                  {mute.until_at ? `Until ${new Date(mute.until_at).toLocaleString()}` : "Permanent"}
                  {mute.reason ? ` · ${mute.reason}` : ""}
                </span>
              </div>
              <button className="cp-btn" disabled={busy !== null} onClick={() => void unmute(mute.user_id)}>
                <Volume2 size={13} /> Unmute
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
