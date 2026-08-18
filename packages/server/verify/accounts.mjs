/**
 * Player accounts (ROADMAP.md §5.1) end to end: signup validation, the real
 * verification email, the click-through redirect + cookie, login (including
 * the unverified/wrong-password refusals), and the paint transaction
 * attributing to user_stats once a session is linked to an account.
 *
 * Needs a real SMTP catcher to read the verification link out of — `pnpm
 * mail:dev` (maildev, http://127.0.0.1:1080) on this Docker-less dev box.
 * Skipped, not failed, without one: this script proves the flow works for
 * real rather than mocking the one part (email delivery) that is easiest to
 * get subtly wrong.
 */
import { finish } from "./finish.mjs";

const BASE = "http://127.0.0.1:8080";
const MAILDEV = process.env.MAILDEV_URL ?? "http://127.0.0.1:1080";
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:5173";
const stamp = Date.now();
const EMAIL = `verify-accounts-${stamp}@example.com`;
const PASSWORD = "correcthorsebattery";
const DISPLAY_NAME = `VerifyRun${stamp % 100000}`;
const X = 900000 + Math.floor(Math.random() * 200);
const Y = 900000 + Math.floor(Math.random() * 200);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);

async function post(path, body, cookie = "") {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, cookies: cookiesOf(res) };
}

const maildevUp = await fetch(`${MAILDEV}/api/email`).then((r) => r.ok).catch(() => false);
if (!maildevUp) {
  console.log(`SKIP  no maildev catcher reachable at ${MAILDEV} — run \`pnpm mail:dev\` to exercise this script`);
  finish(0, "accounts");
} else {
  // ---- validation -----------------------------------------------------------
  const badEmail = await post("/api/auth/signup", { email: "not-an-email", password: PASSWORD, displayName: DISPLAY_NAME });
  check("rejects an invalid email", badEmail.status === 400, `HTTP ${badEmail.status}`);

  const badPassword = await post("/api/auth/signup", { email: EMAIL, password: "short", displayName: DISPLAY_NAME });
  check("rejects a too-short password", badPassword.status === 400, `HTTP ${badPassword.status}`);

  const badName = await post("/api/auth/signup", { email: EMAIL, password: PASSWORD, displayName: "ab" });
  check("rejects a too-short display name", badName.status === 400, `HTTP ${badName.status}`);

  // ---- signup -----------------------------------------------------------------
  const signup = await post("/api/auth/signup", { email: EMAIL, password: PASSWORD, displayName: DISPLAY_NAME });
  check("signup succeeds", signup.status === 200 && signup.body.ok === true, JSON.stringify(signup.body));

  const dupeEmail = await post("/api/auth/signup", { email: EMAIL, password: PASSWORD, displayName: `${DISPLAY_NAME}x` });
  check(
    "duplicate email answers like a fresh signup, not a 409 (no account-existence oracle)",
    dupeEmail.status === 200 && dupeEmail.body.ok === true,
    JSON.stringify(dupeEmail.body),
  );

  const dupeName = await post("/api/auth/signup", { email: `x${EMAIL}`, password: PASSWORD, displayName: DISPLAY_NAME });
  check("rejects a duplicate display name", dupeName.status === 409, `HTTP ${dupeName.status}`);

  // ---- login before verifying is refused ---------------------------------------
  const earlyLogin = await post("/api/auth/login", { identifier: EMAIL, password: PASSWORD });
  check("login before verification is refused", earlyLogin.status === 403, `HTTP ${earlyLogin.status}`);

  // ---- the real email --------------------------------------------------------
  let msg = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !msg) {
    const list = await fetch(`${MAILDEV}/api/email`).then((r) => r.json());
    msg = list.find((m) => m.to?.[0]?.address === EMAIL);
    if (!msg) await sleep(200);
  }
  check("a verification email arrived", Boolean(msg));

  const linkMatch = msg && /(https?:\/\/\S*\/api\/auth\/verify\?token=\S+)/.exec(msg.text);
  check("the email contains a verification link", Boolean(linkMatch));

  // ---- an invalid token redirects to the error state ----------------------------
  const badToken = await fetch(`${BASE}/api/auth/verify?token=not-a-real-token`, { redirect: "manual" });
  check(
    "an invalid token redirects to ?verify_error=1",
    badToken.status === 302 && badToken.headers.get("location") === `${PUBLIC_URL}/?verify_error=1`,
    badToken.headers.get("location"),
  );

  // ---- verifying for real ------------------------------------------------------
  let userCookie = "";
  let verifySessCookie = "";
  if (linkMatch) {
    const verifyRes = await fetch(linkMatch[1], { redirect: "manual" });
    check(
      "the real link redirects to ?verified=1",
      verifyRes.status === 302 && verifyRes.headers.get("location") === `${PUBLIC_URL}/?verified=1`,
      verifyRes.headers.get("location"),
    );
    const verifyCookies = cookiesOf(verifyRes);
    userCookie = verifyCookies.find((c) => c.startsWith("wc_user=")) ?? "";
    check("verifying sets the wc_user cookie", Boolean(userCookie));
    // Verifying has no session cookie yet on this request (a fresh browser
    // clicking the emailed link straight from its inbox), so getOrCreateSession
    // mints one here — this is the anonymous session that must end up linked.
    verifySessCookie = verifyCookies.find((c) => c.startsWith("wc_sess=")) ?? "";
    check("verifying also mints an anonymous session cookie", Boolean(verifySessCookie));

    const replay = await fetch(linkMatch[1], { redirect: "manual" });
    check(
      "the same token cannot be replayed",
      replay.status === 302 && replay.headers.get("location") === `${PUBLIC_URL}/?verify_error=1`,
      replay.headers.get("location"),
    );
  }

  // ---- /api/auth/me reflects the verified account --------------------------------
  if (userCookie) {
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: userCookie } }).then((r) => r.json());
    check("me returns the right email + display name", me.email === EMAIL && me.displayName === DISPLAY_NAME, JSON.stringify(me));
    check("a brand-new account has zero stats", me.cumulative === 0 && me.held === 0, JSON.stringify(me));
  }

  // ---- clicking the verify link alone must be enough to attribute paints ---------
  // This is the real path: a player signs up, clicks the emailed link once, and
  // starts painting — never calling POST /api/auth/login separately. Verifying
  // "doubles as a first login" (see the handler's own comment), so it must link
  // this browser's session exactly like an explicit login does, or every paint
  // made straight after verifying silently never reaches user_stats.
  if (userCookie && verifySessCookie) {
    const verifyJar = [verifySessCookie, userCookie].join("; ");
    const vx = X + 1000; // distinct pixel from the later login-based paint check
    const vy = Y + 1000;
    const verifyPaint = await post("/api/paint", { x: vx, y: vy, color: 3 }, verifyJar);
    check("paint right after verifying (no explicit login) succeeds", verifyPaint.status === 200, JSON.stringify(verifyPaint.body));

    const bootAfterVerifyPaint = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: verifyJar } }).then((r) => r.json());
    check(
      "that paint attributed to user_stats without ever calling /api/auth/login",
      bootAfterVerifyPaint.user?.cumulative === 1 && bootAfterVerifyPaint.user?.held === 1,
      JSON.stringify(bootAfterVerifyPaint.user),
    );
  }

  // ---- wrong password ------------------------------------------------------------
  const wrongPw = await post("/api/auth/login", { identifier: EMAIL, password: "wrongpassword" });
  check("wrong password is refused", wrongPw.status === 401, `HTTP ${wrongPw.status}`);

  // ---- real login, linking this browser's anonymous session --------------------
  const login = await post("/api/auth/login", { identifier: EMAIL, password: PASSWORD });
  check("login succeeds now that the account is verified", login.status === 200 && login.body.user?.email === EMAIL, JSON.stringify(login.body));

  // ---- logging in by display name works exactly like by email ------------------
  const loginByName = await post("/api/auth/login", { identifier: DISPLAY_NAME, password: PASSWORD });
  check(
    "login by display name succeeds",
    loginByName.status === 200 && loginByName.body.user?.email === EMAIL,
    JSON.stringify(loginByName.body),
  );
  const loginByNameMixedCase = await post("/api/auth/login", {
    identifier: DISPLAY_NAME.toUpperCase(),
    password: PASSWORD,
  });
  check(
    "login by display name is case-insensitive",
    loginByNameMixedCase.status === 200 && loginByNameMixedCase.body.user?.email === EMAIL,
    JSON.stringify(loginByNameMixedCase.body),
  );
  const sessCookie = login.cookies.find((c) => c.startsWith("wc_sess="));
  const loginUserCookie = login.cookies.find((c) => c.startsWith("wc_user="));
  check("login issues both an anonymous session and a user session", Boolean(sessCookie && loginUserCookie));
  const jar = [sessCookie, loginUserCookie].filter(Boolean).join("; ");

  // ---- paint attributes to user_stats --------------------------------------------
  const paint = await post("/api/paint", { x: X, y: Y, color: 7 }, jar);
  check("paint from the logged-in session succeeds", paint.status === 200, JSON.stringify(paint.body));

  const bootAfterPaint = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: jar } }).then((r) => r.json());
  check(
    // 2, not 1: the verify-link paint above already put this account at 1/1
    // — this is the same account accumulating a second, distinct pixel.
    "bootstrap now reports the account with an updated stats row",
    bootAfterPaint.user?.email === EMAIL && bootAfterPaint.user?.cumulative === 2 && bootAfterPaint.user?.held === 2,
    JSON.stringify(bootAfterPaint.user),
  );

  // ---- profile picture upload, delivery, and removal --------------------------
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const avatarForm = new FormData();
  avatarForm.append("avatar", new Blob([png], { type: "image/png" }), "avatar.png");
  const avatarUpload = await fetch(`${BASE}/api/auth/avatar`, {
    method: "POST",
    headers: { cookie: jar },
    body: avatarForm,
  });
  const avatarUploadBody = await avatarUpload.json();
  const avatarRevision = avatarUploadBody.user?.avatarRevision;
  check(
    "profile picture upload returns a revision",
    avatarUpload.status === 200 && typeof avatarRevision === "string",
    JSON.stringify(avatarUploadBody),
  );

  if (avatarRevision) {
    const avatarImage = await fetch(
      `${BASE}/avatars/${avatarUploadBody.user.id}/${avatarRevision}.webp`,
    );
    const avatarBytes = Buffer.from(await avatarImage.arrayBuffer());
    check(
      "normalized profile picture is publicly served as WebP",
      avatarImage.status === 200 &&
        avatarImage.headers.get("content-type") === "image/webp" &&
        avatarBytes.subarray(8, 12).toString("ascii") === "WEBP",
      `HTTP ${avatarImage.status} ${avatarImage.headers.get("content-type")}`,
    );
  }

  const removeAvatar = await fetch(`${BASE}/api/auth/avatar`, {
    method: "DELETE",
    headers: { cookie: jar },
  });
  const removeAvatarBody = await removeAvatar.json();
  check(
    "removing the profile picture restores the fallback",
    removeAvatar.status === 200 && removeAvatarBody.user?.avatarRevision === null,
    JSON.stringify(removeAvatarBody),
  );

  // ---- logout ----------------------------------------------------------------
  const logout = await post("/api/auth/logout", {}, jar);
  check("logout succeeds", logout.status === 200, `HTTP ${logout.status}`);
  const afterLogout = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: jar } });
  check("me 404s after logout", afterLogout.status === 404, `HTTP ${afterLogout.status}`);

  // ---- resend-verification does not leak account existence ----------------------
  const resendReal = await post("/api/auth/resend-verification", { email: EMAIL });
  const resendFake = await post("/api/auth/resend-verification", { email: "definitely-not-a-real-account@example.com" });
  check(
    "resend-verification answers identically for a real (already-verified) and a fake account",
    resendReal.status === resendFake.status && resendReal.body.message === resendFake.body.message,
    `${resendReal.status} ${JSON.stringify(resendReal.body)} vs ${resendFake.status} ${JSON.stringify(resendFake.body)}`,
  );

  // ---- password reset ----------------------------------------------------------
  // A second, still-active login session (distinct from the logged-out `jar`
  // above) — this is the one a real reset is supposed to kill, proving the
  // "a live reset link outranks a stolen session cookie" guarantee for real
  // rather than by reading the DELETE statement and assuming it fires.
  const secondLogin = await post("/api/auth/login", { identifier: EMAIL, password: PASSWORD });
  const secondJar = [
    secondLogin.cookies.find((c) => c.startsWith("wc_sess=")),
    secondLogin.cookies.find((c) => c.startsWith("wc_user=")),
  ].filter(Boolean).join("; ");
  const secondMeBefore = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: secondJar } });
  check("second login session works before any reset", secondMeBefore.status === 200, `HTTP ${secondMeBefore.status}`);

  const requestReset = await post("/api/auth/request-reset", { email: EMAIL });
  check("request-reset accepted", requestReset.status === 200 && requestReset.body.ok === true, JSON.stringify(requestReset.body));

  const requestResetFake = await post("/api/auth/request-reset", { email: "definitely-not-a-real-account@example.com" });
  check(
    "request-reset answers identically for a real and a fake account",
    requestReset.body.message === requestResetFake.body.message,
    `${JSON.stringify(requestReset.body)} vs ${JSON.stringify(requestResetFake.body)}`,
  );

  let resetMsg = null;
  const resetDeadline = Date.now() + 5000;
  while (Date.now() < resetDeadline && !resetMsg) {
    const list = await fetch(`${MAILDEV}/api/email`).then((r) => r.json());
    resetMsg = list.find((m) => m.to?.[0]?.address === EMAIL && /Reset your/.test(m.subject));
    if (!resetMsg) await sleep(200);
  }
  check("a reset email arrived", Boolean(resetMsg));
  const resetLinkMatch = resetMsg && /resetToken=(\S+)/.exec(resetMsg.text);
  check("the reset email contains a token", Boolean(resetLinkMatch));
  const resetToken = resetLinkMatch?.[1];

  if (resetToken) {
    const tooShort = await post("/api/auth/reset", { token: resetToken, password: "short" });
    check("rejects a too-short new password", tooShort.status === 400, `HTTP ${tooShort.status}`);

    const badToken = await post("/api/auth/reset", { token: "not-a-real-token", password: "brandNewPassword1" });
    check("rejects a garbage token", badToken.status === 400, `HTTP ${badToken.status}`);

    const NEW_PASSWORD = "brandNewPassword1";
    const doReset = await post("/api/auth/reset", { token: resetToken, password: NEW_PASSWORD });
    check("reset succeeds and returns the account", doReset.status === 200 && doReset.body.user?.email === EMAIL, JSON.stringify(doReset.body));
    const resetJar = [
      doReset.cookies.find((c) => c.startsWith("wc_sess=")),
      doReset.cookies.find((c) => c.startsWith("wc_user=")),
    ].filter(Boolean).join("; ");
    check("reset auto-issues a working session", Boolean(resetJar));

    const replayReset = await post("/api/auth/reset", { token: resetToken, password: "anotherPassword2" });
    check("the same reset token cannot be replayed", replayReset.status === 400, `HTTP ${replayReset.status}`);

    const oldPasswordLogin = await post("/api/auth/login", { identifier: EMAIL, password: PASSWORD });
    check("the old password no longer works", oldPasswordLogin.status === 401, `HTTP ${oldPasswordLogin.status}`);

    const newPasswordLogin = await post("/api/auth/login", { identifier: EMAIL, password: NEW_PASSWORD });
    check("the new password logs in", newPasswordLogin.status === 200, `HTTP ${newPasswordLogin.status}`);

    const secondMeAfter = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: secondJar } });
    check(
      "resetting the password signs out every other session",
      secondMeAfter.status === 404,
      `HTTP ${secondMeAfter.status}`,
    );

    if (resetJar) {
      const meViaReset = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: resetJar } });
      check("the session issued by the reset itself still works", meViaReset.status === 200, `HTTP ${meViaReset.status}`);
    }
  }

  finish(failures, "accounts");
}
