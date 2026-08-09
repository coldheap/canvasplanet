/**
 * Player accounts (ROADMAP.md §5.1) — a claimable upgrade over anonymous
 * play: a persistent display name and (later, §5.2) a place on the player
 * leaderboard. Signing in links this browser's existing anonymous session to
 * the account (routes/auth.ts's /api/auth/login), so paint attribution
 * starts immediately — nothing about paint eligibility changes either way.
 */

import { useState } from "react";
import { AlertOctagon, Check, Flame, KeyRound, LogIn, LogOut, Mail, UserCircle, UserPlus } from "lucide-react";
import type { UserDTO } from "@worldcanvas/shared";
import { api } from "../api.js";
import { useStore } from "../store.js";

/** Lucide has no brand icons — this is Discord's own "Clyde" mark, the one
 *  every official Discord button uses, inlined so the button reads as an
 *  actual Discord control rather than a generic chat bubble. */
function DiscordIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.522 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

export function AccountPanel() {
  const { user, setUser, pendingResetToken, setPendingResetToken } = useStore();

  // A password-reset link takes priority over whatever else this panel would
  // otherwise show — arriving here at all means the browser just followed an
  // emailed link, which is a deliberate, specific action to finish.
  if (pendingResetToken) {
    return (
      <ResetPasswordForm
        token={pendingResetToken}
        onDone={(u) => {
          setUser(u);
          setPendingResetToken(null);
        }}
        onCancel={() => setPendingResetToken(null)}
      />
    );
  }

  return user ? <AccountSummary user={user} setUser={setUser} /> : <AuthForms setUser={setUser} />;
}

function AccountSummary({ user, setUser }: { user: UserDTO; setUser: (u: UserDTO | null) => void }) {
  const [busy, setBusy] = useState(false);

  async function logout(): Promise<void> {
    setBusy(true);
    await api.logout();
    setUser(null);
    setBusy(false);
  }

  return (
    <div className="wc-staff-login">
      <h2 className="wc-panel-title">
        <UserCircle size={16} />
        Account
      </h2>
      <p className="wc-account-name">{user.displayName}</p>
      {user.email && <p className="wc-hint">{user.email}</p>}
      <p className="wc-account-stats">
        <span>{user.cumulative.toLocaleString()} painted</span>
        <span>{user.held.toLocaleString()} held</span>
      </p>
      {user.streakDays >= 2 && (
        <p className="wc-account-streak">
          <Flame size={14} />
          {user.streakDays}-day streak
          {user.bestStreak > user.streakDays && (
            <span className="wc-hint"> · best {user.bestStreak}</span>
          )}
        </p>
      )}
      <button className="wc-btn" disabled={busy} onClick={() => void logout()}>
        <LogOut size={15} />
        Sign out
      </button>
    </div>
  );
}

function ResetPasswordForm({
  token,
  onDone,
  onCancel,
}: {
  token: string;
  onDone: (user: UserDTO) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.resetPassword(token, password);
      onDone(res.user);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "That reset link is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wc-staff-login" onSubmit={(e) => void submit(e)}>
      <h2 className="wc-panel-title">
        <KeyRound size={16} />
        Choose a new password
      </h2>
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        autoFocus
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="Confirm new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      <button type="submit" className="wc-btn wc-btn-primary" disabled={busy}>
        <Check size={15} />
        Set new password
      </button>
      <button type="button" className="wc-btn" onClick={onCancel}>
        Cancel
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

function AuthForms({ setUser }: { setUser: (u: UserDTO | null) => void }) {
  const discordEnabled = useStore((s) => s.discordEnabled);
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once signup succeeds, so "resend" knows which address to target
   *  without asking the user to retype it. */
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  /** Set once a reset request has actually been sent, so the form can't be
   *  resubmitted into a fresh cooldown 429 by mashing the button. */
  const [resetRequested, setResetRequested] = useState(false);

  function switchMode(next: typeof mode): void {
    setMode(next);
    setError(null);
    setNotice(null);
    setResetRequested(false);
  }

  async function submitLogin(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(identifier, password);
      setUser(res.user);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function submitSignup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signup({ email, password, displayName });
      setPendingEmail(email);
      setNotice("Check your email for a verification link to finish creating your account.");
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not create that account.");
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestPasswordReset(email);
      setNotice(res.message);
      setResetRequested(true);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not send a reset link.");
    } finally {
      setBusy(false);
    }
  }

  async function resend(): Promise<void> {
    if (!pendingEmail) return;
    setBusy(true);
    try {
      const res = await api.resendVerification(pendingEmail);
      setNotice(res.message);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not resend the email.");
    } finally {
      setBusy(false);
    }
  }

  if (pendingEmail) {
    return (
      <div className="wc-staff-login">
        <h2 className="wc-panel-title">
          <Mail size={16} />
          Verify your email
        </h2>
        <p className="wc-hint">{notice}</p>
        <button className="wc-btn" disabled={busy} onClick={() => void resend()}>
          Resend verification email
        </button>
        {error && (
          <p className="wc-error">
            <AlertOctagon size={14} />
            {error}
          </p>
        )}
      </div>
    );
  }

  if (mode === "forgot") {
    return (
      <form className="wc-staff-login" onSubmit={(e) => void submitForgot(e)}>
        <h2 className="wc-panel-title">
          <KeyRound size={16} />
          Reset your password
        </h2>
        {resetRequested ? (
          <p className="wc-hint">{notice}</p>
        ) : (
          <>
            <input
              type="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
            <button type="submit" className="wc-btn wc-btn-primary" disabled={busy}>
              <Mail size={15} />
              Send reset link
            </button>
          </>
        )}
        <button type="button" className="wc-btn" onClick={() => switchMode("login")}>
          Back to sign in
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

  return (
    <form
      className="wc-staff-login"
      onSubmit={(e) => void (mode === "login" ? submitLogin(e) : submitSignup(e))}
    >
      <h2 className="wc-panel-title">
        <UserCircle size={16} />
        Account
      </h2>
      <div className="wc-lb-toggle" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => switchMode("login")}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => switchMode("signup")}>
          Sign up
        </button>
      </div>

      {mode === "login" ? (
        <input
          type="text"
          autoComplete="username"
          placeholder="Email or username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
      ) : (
        <>
          <input
            type="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            placeholder="Display name"
            maxLength={24}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </>
      )}
      <input
        type="password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      <button type="submit" className="wc-btn wc-btn-primary" disabled={busy}>
        {mode === "login" ? <LogIn size={15} /> : <UserPlus size={15} />}
        {mode === "login" ? "Sign in" : "Create account"}
      </button>

      {discordEnabled && (
        <>
          <p className="wc-auth-divider">or</p>
          {/* A plain navigation, not a fetch call — routes/auth.ts's
              /api/auth/discord redirects straight to Discord's own
              authorize screen. */}
          <a className="wc-btn wc-btn-discord" href="/api/auth/discord">
            <DiscordIcon />
            Continue with Discord
          </a>
        </>
      )}

      {mode === "login" && (
        <button type="button" className="wc-link-btn" onClick={() => switchMode("forgot")}>
          Forgot password?
        </button>
      )}

      {error && (
        <p className="wc-error">
          <AlertOctagon size={14} />
          {error}
        </p>
      )}
    </form>
  );
}
