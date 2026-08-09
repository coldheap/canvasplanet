import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Flag, LoaderCircle, Send, Shield, Trash2, UserRound, X } from "lucide-react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import "./ChatPanel.css";

function errorMessage(error: unknown, fallback: string): string {
  const body = (error as { body?: { error?: string } })?.body;
  return body?.error ?? fallback;
}

export function ChatPanel({ onClose, onLogin }: { onClose: () => void; onLogin: () => void }) {
  const { chatMessages, mergeChatMessages, user, staff } = useStore();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(chatMessages.length === 0);
  const [hasMore, setHasMore] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<number | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [moderating, setModerating] = useState<number | null>(null);
  const [moderationReason, setModerationReason] = useState("");
  const [muteHours, setMuteHours] = useState("24");
  const [busyAction, setBusyAction] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const initialScrollDone = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.chatMessages()
      .then((page) => {
        if (cancelled) return;
        mergeChatMessages(page.messages);
        setHasMore(page.hasMore);
      })
      .catch(() => !cancelled && setError("Could not load chat."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [mergeChatMessages]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || loading) return;
    if (!initialScrollDone.current) {
      list.scrollTop = list.scrollHeight;
      initialScrollDone.current = true;
      return;
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }, [chatMessages, loading]);

  const characterCount = useMemo(() => [...draft].length, [draft]);

  async function loadOlder(): Promise<void> {
    const before = chatMessages[0]?.id;
    const list = listRef.current;
    if (!before || !list || loading || chatMessages.length >= 500) return;
    const previousHeight = list.scrollHeight;
    setLoading(true);
    try {
      const page = await api.chatMessages(before);
      mergeChatMessages(page.messages);
      setHasMore(page.hasMore);
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop += listRef.current.scrollHeight - previousHeight;
      });
    } catch {
      setError("Could not load older messages.");
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(): Promise<void> {
    const body = draft.trim();
    if (!body || characterCount > 400 || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await api.sendChatMessage(body);
      mergeChatMessages([response.message]);
      setDraft("");
      if (composerRef.current) composerRef.current.style.height = "auto";
    } catch (error) {
      setError(errorMessage(error, "Could not send that message."));
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void sendMessage();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function reportMessage(id: number): Promise<void> {
    setBusyAction(true);
    setError(null);
    try {
      const result = await api.reportChatMessage(id, reportReason.trim() || undefined);
      setReporting(null);
      setReportReason("");
      setError(result.counted ? "Report sent to the moderation team." : "You already reported this message.");
    } catch (error) {
      setError(errorMessage(error, "Could not send that report."));
    } finally {
      setBusyAction(false);
    }
  }

  async function deleteMessage(id: number): Promise<void> {
    setBusyAction(true);
    setError(null);
    try {
      const result = await api.admin.deleteChatMessage(id, moderationReason.trim() || undefined);
      mergeChatMessages([result.message]);
      setModerating(null);
      setModerationReason("");
    } catch (error) {
      setError(errorMessage(error, "Could not remove that message."));
    } finally {
      setBusyAction(false);
    }
  }

  async function muteUser(userId: number): Promise<void> {
    setBusyAction(true);
    setError(null);
    try {
      await api.admin.muteChatUser(
        userId,
        muteHours === "permanent" ? null : Number(muteHours),
        moderationReason.trim() || undefined,
      );
      setModerating(null);
      setModerationReason("");
      setError("User muted from chat.");
    } catch (error) {
      setError(errorMessage(error, "Could not mute that user."));
    } finally {
      setBusyAction(false);
    }
  }

  return (
    <aside id="world-chat-panel" className="wc-chat wc-chat-compact wc-card" aria-label="World chat">
      <header className="wc-chat-head">
        <strong>World chat</strong>
        <button className="wc-chat-close" aria-label="Close chat" title="Close chat" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <div className="wc-chat-list" ref={listRef} role="log" aria-live="polite">
        {hasMore && chatMessages.length > 0 && chatMessages.length < 500 && (
          <button className="wc-chat-older" disabled={loading} onClick={() => void loadOlder()}>
            {loading ? <LoaderCircle className="wc-spin" size={13} /> : null}
            Load older messages
          </button>
        )}
        {loading && chatMessages.length === 0 ? (
          <p className="wc-chat-empty"><LoaderCircle className="wc-spin" size={16} /> Loading chat…</p>
        ) : chatMessages.length === 0 ? (
          <p className="wc-chat-empty">No messages yet.</p>
        ) : (
          chatMessages.map((message) => (
            <article className={`wc-chat-message${message.deleted ? " is-deleted" : ""}`} key={message.id}>
              <ChatAvatar
                userId={message.userId}
                name={message.displayName}
                revision={message.avatarRevision}
                size={27}
              />
              <div className="wc-chat-message-body">
                <div className="wc-chat-meta">
                  <strong>{message.displayName}</strong>
                  <time title={new Date(message.createdAt).toLocaleString()} dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </time>
                  {!message.deleted && user && user.id !== message.userId && (
                    <button
                      title="Report message"
                      aria-label={`Report ${message.displayName}'s message`}
                      onClick={() => { setReporting(reporting === message.id ? null : message.id); setModerating(null); }}
                    >
                      <Flag size={12} />
                    </button>
                  )}
                  {!message.deleted && staff && (
                    <button
                      title="Moderate message"
                      aria-label={`Moderate ${message.displayName}`}
                      onClick={() => { setModerating(moderating === message.id ? null : message.id); setReporting(null); }}
                    >
                      <Shield size={12} />
                    </button>
                  )}
                </div>
                {message.deleted ? <p className="wc-chat-removed">Message removed</p> : <p>{message.body}</p>}

                {reporting === message.id && (
                  <div className="wc-chat-action-box">
                    <input
                      value={reportReason}
                      maxLength={400}
                      placeholder="Why are you reporting this? (optional)"
                      onChange={(event) => setReportReason(event.target.value)}
                    />
                    <div>
                      <button className="wc-btn" disabled={busyAction} onClick={() => setReporting(null)}>Cancel</button>
                      <button className="wc-btn wc-btn-primary" disabled={busyAction} onClick={() => void reportMessage(message.id)}>
                        <Flag size={13} /> Report
                      </button>
                    </div>
                  </div>
                )}

                {moderating === message.id && (
                  <div className="wc-chat-action-box wc-chat-mod-box">
                    <input
                      value={moderationReason}
                      maxLength={400}
                      placeholder="Moderation reason (optional)"
                      onChange={(event) => setModerationReason(event.target.value)}
                    />
                    <select value={muteHours} onChange={(event) => setMuteHours(event.target.value)}>
                      <option value="1">Mute 1 hour</option>
                      <option value="24">Mute 24 hours</option>
                      <option value="168">Mute 7 days</option>
                      <option value="permanent">Mute permanently</option>
                    </select>
                    <div>
                      <button className="wc-btn" disabled={busyAction} onClick={() => void muteUser(message.userId)}>
                        <Shield size={13} /> Mute user
                      </button>
                      <button className="wc-danger" disabled={busyAction} onClick={() => void deleteMessage(message.id)}>
                        <Trash2 size={13} /> Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {error && <div className="wc-chat-status" role="status">{error}</div>}

      {user ? (
        <form className="wc-chat-compose" onSubmit={submit}>
          <ChatAvatar
            userId={user.id}
            name={user.displayName}
            revision={chatMessages.slice().reverse().find((message) => message.userId === user.id)?.avatarRevision ?? null}
            size={29}
          />
          <div className="wc-chat-input-wrap">
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              aria-label="Chat message"
              placeholder="Type a message…"
              onChange={(event) => {
                setDraft(event.target.value);
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = `${Math.min(88, event.currentTarget.scrollHeight)}px`;
              }}
              onKeyDown={keyDown}
            />
            {characterCount > 320 && <span className={characterCount > 400 ? "is-over" : ""}>{characterCount}/400</span>}
          </div>
          <button
            className="wc-chat-send"
            type="submit"
            aria-label="Send message"
            disabled={sending || !draft.trim() || characterCount > 400}
          >
            {sending ? <LoaderCircle className="wc-spin" size={16} /> : <Send size={16} />}
          </button>
        </form>
      ) : (
        <button className="wc-chat-login" onClick={onLogin}>
          Log in / Sign up <span>to join the conversation</span>
        </button>
      )}
    </aside>
  );
}

/** Small self-contained avatar renderer for chat messages. */
export function ChatAvatar({
  userId,
  name,
  revision,
  size,
}: {
  userId: number;
  name: string;
  revision: string | null;
  size: number;
}) {
  const src = revision ? `/avatars/${userId}/${revision}.webp` : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className="wc-chat-avatar" style={{ width: size, height: size, fontSize: Math.max(10, size * 0.42) }} aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <UserRound size={Math.max(12, Math.round(size * 0.58))} strokeWidth={2} aria-hidden="true" />
      )}
    </span>
  );
}
